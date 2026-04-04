import { Component, effect, model, NgZone, OnDestroy, OnInit, output, signal, ViewEncapsulation } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ElectronService } from '../../../core/electron.service';

const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 5.0;
const STEP = 0.5;
const SILENCE_RMS = 0.015;

export interface AudioDevice {
  deviceId: string;
  label: string;
}

@Component({
  selector: 'app-talk-mode',
  imports: [DecimalPipe],
  templateUrl: './talk-mode.html',
  styleUrl: './talk-mode.css',
  encapsulation: ViewEncapsulation.None
})
export class TalkMode implements OnInit, OnDestroy {
  readonly talkEnabled = model(false);
  readonly silenceThreshold = signal(2.0);
  readonly listening = signal(false);
  readonly currentTranscript = model('');
  readonly promptCaptured = output<string>();
  /** Fired when voice crosses the activity threshold and capture for an utterance begins. */
  readonly recordingBegan = output<void>();
  /** Fired when a capture cycle ends (after transcription or empty audio). */
  readonly talkCaptureFinished = output<{ hadSpeech: boolean }>();
  readonly audioDevices = signal<AudioDevice[]>([]);
  readonly selectedDeviceId = signal('default');
  readonly statusMessage = signal('');

  private audioContext: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private deviceChangeHandler = () => {
    void this.loadDevices();
  };
  private micStream: MediaStream | null = null;
  private pcmChunks: Float32Array[] = [];
  private hasVoice = false;
  private silentMs = 0;
  private transcribing = false;

  constructor(private zone: NgZone, private electron: ElectronService) {
    effect(() => {
      const enabled = this.talkEnabled();
      if (enabled) {
        this.startCapture();
      } else {
        this.stopCapture();
      }
    });
  }

  async ngOnInit(): Promise<void> {
    await this.loadDevices();
    navigator.mediaDevices?.addEventListener('devicechange', this.deviceChangeHandler);
  }

  ngOnDestroy(): void {
    this.stopCapture();
    navigator.mediaDevices?.removeEventListener('devicechange', this.deviceChangeHandler);
  }

  toggle(): void {
    this.talkEnabled.set(!this.talkEnabled());
  }

  decreaseThreshold(): void {
    const next = Math.max(MIN_THRESHOLD, +(this.silenceThreshold() - STEP).toFixed(1));
    this.silenceThreshold.set(next);
  }

  increaseThreshold(): void {
    const next = Math.min(MAX_THRESHOLD, +(this.silenceThreshold() + STEP).toFixed(1));
    this.silenceThreshold.set(next);
  }

  onDeviceChange(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    this.selectedDeviceId.set(id);
    if (this.talkEnabled()) {
      this.stopCapture();
      this.startCapture();
    }
  }

  private async loadDevices(): Promise<void> {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`
        }));
      this.zone.run(() => {
        this.audioDevices.set(inputs);
        const selectedId = this.selectedDeviceId();
        const hasSelectedDevice = selectedId === 'default' || inputs.some((device) => device.deviceId === selectedId);
        if (!hasSelectedDevice) {
          this.selectedDeviceId.set('default');
        }
        if (!inputs.length) {
          this.statusMessage.set('No microphone detected');
        } else if (this.statusMessage() === 'No microphone detected') {
          this.statusMessage.set('');
        }
      });
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err);
      this.zone.run(() => this.statusMessage.set('Microphone permission is required'));
    }
  }

  private async startCapture(): Promise<void> {
    this.stopCapture();

    const constraints: MediaStreamConstraints = {
      audio: this.selectedDeviceId() !== 'default'
        ? { deviceId: { exact: this.selectedDeviceId() } }
        : true
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

    this.processorNode.onaudioprocess = (event) => {
      const buf = event.inputBuffer;
      const rms = this.maxChannelRms(buf);
      const input = this.getMonoPcm(buf);

      if (rms > SILENCE_RMS) {
        if (!this.hasVoice && !this.transcribing) {
          this.hasVoice = true;
          this.zone.run(() => {
            this.currentTranscript.set('Recording...');
            this.recordingBegan.emit();
          });
        }
        this.silentMs = 0;
      } else if (this.hasVoice) {
        this.silentMs += bufferDurationMs;
      }

      if (this.hasVoice) {
        this.pcmChunks.push(input);
      }

      if (this.hasVoice && this.silentMs >= this.silenceThreshold() * 1000 && !this.transcribing) {
        this.transcribing = true;
        const samples = this.mergePcmChunks();
        const wav = this.encodeWav(samples, sampleRate);
        this.pcmChunks = [];
        this.hasVoice = false;
        this.silentMs = 0;

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
    this.listening.set(false);
    this.currentTranscript.set('');
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
    } finally {
      this.transcribing = false;
      const captured = hadSpeech;
      this.zone.run(() => {
        this.talkCaptureFinished.emit({ hadSpeech: captured });
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
