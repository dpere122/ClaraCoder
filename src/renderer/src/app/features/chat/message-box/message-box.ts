import { Component, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-message-box',
  imports: [FormsModule],
  templateUrl: './message-box.html',
  styleUrl: './message-box.css'
})
export class MessageBox {
  readonly talkStatus = input('');
  readonly messageSent = output<string>();
  protected readonly userInput = signal('');

  send(): void {
    const msg = this.userInput().trim();
    if (!msg) return;
    this.messageSent.emit(msg);
    this.userInput.set('');
  }
}
