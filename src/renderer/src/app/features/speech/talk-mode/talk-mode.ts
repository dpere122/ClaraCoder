import { Component, effect, input, model, NgZone, OnDestroy, output, signal, ViewEncapsulation } from '@angular/core';
import { ElectronService } from '../../../core/electron.service';
import { TtsPlaybackService } from '../../../core/tts-playback.service';
import { TalkUiState } from '../../../core/talk-ui-state';
import {
  BARGE_SUSTAIN_BUFFERS,
  micExceedsBargeThreshold,
} from '../barge-in-threshold';

@Component({
  selector: 'app-talk-mode',
  imports: [],
  templateUrl: './talk-mode.html',
  styleUrl: './talk-mode.css',
  encapsulation: ViewEncapsulation.None
})
export class TalkMode implements OnDestroy {
  readonly talkEnabled = model(false);
  /** MediaDevices input id from Settings → Audio, or ``"default"``. */
  readonly talkInputDeviceId = input<string>('default');
  /** Seconds of silence after speech before sending audio for transcription. */
  readonly talkSilenceThresholdSec = input<number>(2);
  readonly listening = signal(false);
  readonly currentTranscript = model('');
  readonly promptCaptured = output<string>();
  /** Fired when voice crosses the activity threshold and capture for an utterance begins. */
  readonly recordingBegan = output<void>();
  /** Fired when a capture cycle ends (after transcription or empty audio). */
  readonly talkCaptureFinished = output<{ hadSpeech: boolean; userBargeIn: boolean }>();
  /** Shown in the composer status row (errors, “no speech”, etc.). */
  readonly statusMessage = model('');

  private audioContext: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private micStream: MediaStream | null = null;
  private pcmChunks: Float32Array[] = [];
  private hasVoice = false;
  private silentMs = 0;
  private transcribing = false;
  private aboveThresholdStreak = 0;
  /** Set when sustained mic energy exceeds assistant playback (real barge-in). */
  private userBargeIn = false;

  constructor(
    private zone: NgZone,
    private electron: ElectronService,
    private talkUi: TalkUiState,
    private tts: TtsPlaybackService,
  ) {
    effect(() => {
      const enabled = this.talkEnabled();
      const _device = this.talkInputDeviceId();
      if (enabled) {
        void this.startCapture();
      } else {
        this.stopCapture();
      }
    });
  }

  ngOnDestroy(): void {
    this.stopCapture();
  }

  private async startCapture(): Promise<void> {
    this.stopCapture();

    const deviceId = this.talkInputDeviceId();
    const constraints: MediaStreamConstraints = {
      audio: deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true
    };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error('Failed to acquire microphone:', err);
      this.zone.run(() => {
        this.talkEnabled.set(false);
        this.listening.set(false);
        this.currentTranscript.set('');
        this.statusMessage.set('Unable to access microphone');
      });
      return;
    }

    if (!this.talkEnabled()) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
      return;
    }

    this.audioContext = new AudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.zone.run(() => this.statusMessage.set(''));
    const source = this.audioContext.createMediaStreamSource(this.micStream);
    const bufferSize = 4096;
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    const gain = this.audioContext.createGain();
    gain.gain.value = 0;

    const sampleRate = this.audioContext.sampleRate;
    const bufferDurationMs = (bufferSize / sampleRate) * 1000;

    this.pcmChunks = [];
    this.hasVoice = false;
    this.silentMs = 0;
    this.transcribing = false;
    this.aboveThresholdStreak = 0;
    this.userBargeIn = false;
    this.zone.run(() => this.talkUi.reset());

    this.processorNode.onaudioprocess = (event) => {
      const buf = event.inputBuffer;
      const rms = this.maxChannelRms(buf);
      const input = this.getMonoPcm(buf);
      const silenceThresholdSec = this.talkSilenceThresholdSec();
      const playbackRms = this.tts.getPlaybackRms();
      const aboveBarge = micExceedsBargeThreshold(rms, playbackRms);

      if (aboveBarge) {
        if (!this.hasVoice && !this.transcribing) {
          this.aboveThresholdStreak++;
          if (this.aboveThresholdStreak >= BARGE_SUSTAIN_BUFFERS) {
            this.hasVoice = true;
            this.userBargeIn = true;
            this.zone.run(() => {
              this.currentTranscript.set('Recording...');
              this.talkUi.capturing.set(true);
              this.recordingBegan.emit();
            });
          }
        }
        this.silentMs = 0;
      } else {
        if (!this.hasVoice) {
          this.aboveThresholdStreak = 0;
        } else if (this.hasVoice) {
          this.silentMs += bufferDurationMs;
        }
      }

      if (this.hasVoice) {
        this.pcmChunks.push(input);
      }

      if (this.hasVoice && this.silentMs >= silenceThresholdSec * 1000 && !this.transcribing) {
        this.transcribing = true;
        this.zone.run(() => {
          this.talkUi.capturing.set(false);
          this.talkUi.transcribing.set(true);
        });
        const samples = this.mergePcmChunks();
        const wav = this.encodeWav(samples, sampleRate);
        this.pcmChunks = [];
        this.hasVoice = false;
        this.silentMs = 0;
        this.aboveThresholdStreak = 0;

        this.transcribe(wav);
      }
    };

    source.connect(this.processorNode);
    this.processorNode.connect(gain);
    gain.connect(this.audioContext.destination);
    this.zone.run(() => this.listening.set(true));
  }

  private stopCapture(): void {
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    this.pcmChunks = [];
    this.hasVoice = false;
    this.silentMs = 0;
    this.transcribing = false;
    this.aboveThresholdStreak = 0;
    this.userBargeIn = false;
    this.listening.set(false);
    this.currentTranscript.set('');
    this.zone.run(() => this.talkUi.reset());
  }

  private async transcribe(wav: ArrayBuffer): Promise<void> {
    let hadSpeech = false;
    try {
      this.zone.run(() => this.currentTranscript.set('Transcribing...'));
      const text = await this.electron.transcribe(wav);
      if (text) {
        hadSpeech = true;
        this.zone.run(() => {
          this.currentTranscript.set(text);
          this.promptCaptured.emit(text);
        });
        await new Promise(r => setTimeout(r, 500));
      } else {
        this.zone.run(() => this.statusMessage.set('No speech detected'));
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.error('Transcription failed:', err);
      const msg = err instanceof Error ? err.message : 'Transcription failed';
      this.zone.run(() =>
        this.statusMessage.set(msg.length > 160 ? `${msg.slice(0, 157)}…` : msg),
      );
      if (msg.includes('Dependencies')) {
        this.electron.openDependenciesWindow();
      }
    } finally {
      this.transcribing = false;
      const captured = hadSpeech;
      const bargeIn = this.userBargeIn;
      this.userBargeIn = false;
      this.zone.run(() => {
        this.talkUi.transcribing.set(false);
        this.talkCaptureFinished.emit({ hadSpeech: captured, userBargeIn: bargeIn });
        this.currentTranscript.set('');
        if (this.statusMessage() && this.statusMessage() !== 'Microphone permission is required') {
          setTimeout(() => {
            if (!this.listening()) {
              return;
            }
            this.zone.run(() => this.statusMessage.set(''));
          }, 1500);
        }
      });
    }
  }

  private maxChannelRms(buffer: AudioBuffer): number {
    let max = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      if (!ch.length) {
        continue;
      }
      const rms = Math.sqrt(ch.reduce((sum, v) => sum + v * v, 0) / ch.length);
      max = Math.max(max, rms);
    }
    return max;
  }

  /** Downmix to mono for the WAV sent to transcription. */
  private getMonoPcm(buffer: AudioBuffer): Float32Array {
    const channels = buffer.numberOfChannels;
    const len = buffer.length;
    if (channels === 1) {
      return new Float32Array(buffer.getChannelData(0));
    }
    const out = new Float32Array(len);
    for (let c = 0; c < channels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) {
        out[i] += ch[i];
      }
    }
    const scale = 1 / channels;
    for (let i = 0; i < len; i++) {
      out[i] *= scale;
    }
    return out;
  }

  private mergePcmChunks(): Float32Array {
    const length = this.pcmChunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Float32Array(length);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  private encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const bitsPerSample = 16;
    const byteRate = sampleRate * bitsPerSample / 8;
    const dataSize = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    this.writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeStr(view, 8, 'WAVE');
    this.writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, bitsPerSample, true);
    this.writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    return buffer;
  }

  private writeStr(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
}
