import { Component, input, model, output, ViewEncapsulation } from '@angular/core';
import { FontControl } from '../font-control/font-control';
import { SpeechModule } from '../../speech/speech-module/speech-module';
import { TalkMode } from '../../speech/talk-mode/talk-mode';
import { ThemeSelector } from '../theme-selector/theme-selector';
import { EditorMode } from '../editor-mode/editor-mode';

@Component({
  selector: 'app-tools-bar',
  imports: [FontControl, SpeechModule, TalkMode, ThemeSelector, EditorMode],
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
  /** When true, backend binds edit/write tools (`apply_mode`). */
  readonly editorMode = model(true);
  /** When true, proposed workspace edits are written immediately without diff review (only shown when Editor is on). */
  readonly autoApplyMode = model(false);
  readonly pinned = model(false);
  readonly activeConversationId = input<string | null>(null);
  readonly promptCaptured = output<string>();
  readonly recordingBegan = output<void>();
  readonly talkCaptureFinished = output<{ hadSpeech: boolean }>();

  togglePin(): void {
    this.pinned.set(!this.pinned());
  }

  toggleAutoApply(): void {
    this.autoApplyMode.set(!this.autoApplyMode());
  }
}
