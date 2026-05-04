import { Component, input, output, signal } from '@angular/core';
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
  readonly messageSent = output<string>();
  readonly abortRequested = output<void>();
  protected readonly userInput = signal('');

  onVoiceButtonClick(): void {
    this.voiceToggle.emit();
  }

  send(): void {
    if (this.loading()) return;
    const msg = this.userInput().trim();
    if (!msg) return;
    this.messageSent.emit(msg);
    this.userInput.set('');
  }

  abort(): void {
    this.abortRequested.emit();
  }
}
