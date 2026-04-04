import { Component, input, model, output, ViewEncapsulation } from '@angular/core';
import { FontControl } from '../font-control/font-control';
import { SpeechModule } from '../../speech/speech-module/speech-module';
import { TalkMode } from '../../speech/talk-mode/talk-mode';
import { ThemeSelector } from '../theme-selector/theme-selector';
@Component({
  selector: 'app-tools-bar',
  imports: [FontControl, SpeechModule, TalkMode, ThemeSelector],
  templateUrl: './tools-bar.html',
  styleUrl: './tools-bar.css',
  encapsulation: ViewEncapsulation.None
})
export class ToolsBar {
  readonly fontSize = model(0.9);
  readonly speechEnabled = model(false);
  readonly selectedVoice = model('en-US-AriaNeural');
  readonly currentTranscript = model('');
  readonly talkEnabled = model(false);
  readonly pinned = model(false);
  readonly activeConversationId = input<string | null>(null);
  readonly promptCaptured = output<string>();
  readonly recordingBegan = output<void>();
  readonly talkCaptureFinished = output<{ hadSpeech: boolean }>();

  togglePin(): void {
    this.pinned.set(!this.pinned());
  }
}
