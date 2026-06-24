import { Component, ElementRef, input, model, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  COMPOSER_RUN_MODES,
  COMPOSER_RUN_MODE_LABELS,
  DEFAULT_COMPOSER_RUN_MODE,
  type ComposerRunMode,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-message-box',
  imports: [FormsModule, LucideAngularModule],
  templateUrl: './message-box.html',
  styleUrl: './message-box.css'
})
/**
 * Bottom composer: text input, run-mode selector, voice toggle, and send/abort controls.
 *
 * Parent owns streaming state and talk capture; this component emits user actions upward
 * via {@link messageSent}, {@link abortRequested}, and {@link voiceToggle}.
 */
export class MessageBox {
  /** Two-way run mode for the next turn (Agent vs Plan). */
  readonly composerMode = model<ComposerRunMode>(DEFAULT_COMPOSER_RUN_MODE);
  /** Select options bound in the template. */
  readonly composerModes = COMPOSER_RUN_MODES;
  /** Human-readable labels keyed by {@link ComposerRunMode}. */
  readonly composerModeLabels = COMPOSER_RUN_MODE_LABELS;

  /** Mic + spoken replies active (parent syncs `talkEnabled` && `speechEnabled`). */
  readonly voiceActive = input(false);
  /** User toggled the voice button; parent flips talk/speech state. */
  readonly voiceToggle = output<void>();
  /** Short live caption from talk capture (shown above the input row). */
  readonly talkStatus = input('');
  /** Secondary talk-mode status line when {@link talkStatus} is empty. */
  readonly talkDetail = input('');
  /** Assistant reply in flight — swaps Send for Stop. */
  readonly loading = input(false);
  /** Context window full — input disabled and placeholder explains why. */
  readonly contextBlocked = input(false);
  /** Staged reference-bar file count; allows send with empty text when > 0. */
  readonly attachmentCount = input(0);
  /** Trimmed composer text (may be empty when attachments are present). */
  readonly messageSent = output<string>();
  /** User clicked Stop while {@link loading} is true. */
  readonly abortRequested = output<void>();
  /** Draft text bound to the composer input. */
  protected readonly userInput = signal('');
  /** `#messageInput` in template; used to restore focus after send. */
  private readonly messageInputEl = viewChild<ElementRef<HTMLInputElement>>('messageInput');

  /** Forwards the voice button click to {@link voiceToggle}. */
  onVoiceButtonClick(): void {
    this.voiceToggle.emit();
  }

  /**
   * Validates draft text (or attachments), emits {@link messageSent}, and clears input.
   * No-op while {@link loading} or {@link contextBlocked}.
   */
  send(): void {
    if (this.loading() || this.contextBlocked()) return;
    const msg = this.userInput().trim();
    if (!msg && this.attachmentCount() === 0) return;
    this.messageSent.emit(msg);
    this.userInput.set('');
    this.focusInput();
  }

  /** Emits {@link abortRequested} for the in-flight generation. */
  abort(): void {
    this.abortRequested.emit();
  }

  /**
   * Left-click anywhere on the composer chrome focuses the text field.
   * Defers via microtask so mousedown on the input itself is not fighting focus.
   *
   * @param event - Native mousedown; only primary button is handled.
   */
  onComposerMouseDown(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    queueMicrotask(() => this.focusInput());
  }

  /**
   * Returns keyboard focus to the composer after send or chrome click.
   * Blurs a stale terminal/xterm focus target first so key events route here.
   */
  private focusInput(): void {
    const input = this.messageInputEl()?.nativeElement;
    if (!input || input === document.activeElement) {
      return;
    }
    // Blur stale terminal/xterm focus first so keyboard events route back to composer.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== input) {
      active.blur();
    }
    input.focus({ preventScroll: true });
  }
}
