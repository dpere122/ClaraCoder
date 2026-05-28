import { Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-message-box',
  imports: [FormsModule, LucideAngularModule],
  templateUrl: './message-box.html',
  styleUrl: './message-box.css'
})
export class MessageBox {
  /** Mic + spoken replies (synced with parent `talkEnabled` && `speechEnabled`). */
  readonly voiceActive = input(false);
  readonly voiceToggle = output<void>();
  readonly talkStatus = input('');
  readonly talkDetail = input('');
  readonly loading = input(false);
  readonly contextBlocked = input(false);
  readonly messageSent = output<string>();
  readonly abortRequested = output<void>();
  protected readonly userInput = signal('');
  private readonly messageInputEl = viewChild<ElementRef<HTMLInputElement>>('messageInput');

  onVoiceButtonClick(): void {
    this.voiceToggle.emit();
  }

  send(): void {
    if (this.loading() || this.contextBlocked()) return;
    const msg = this.userInput().trim();
    if (!msg) return;
    this.messageSent.emit(msg);
    this.userInput.set('');
    this.focusInput();
  }

  abort(): void {
    this.abortRequested.emit();
  }

  onComposerMouseDown(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    queueMicrotask(() => this.focusInput());
  }

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
