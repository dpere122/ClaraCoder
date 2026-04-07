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
  readonly talkStatus = input('');
  readonly loading = input(false);
  readonly messageSent = output<string>();
  readonly abortRequested = output<void>();
  protected readonly userInput = signal('');

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
