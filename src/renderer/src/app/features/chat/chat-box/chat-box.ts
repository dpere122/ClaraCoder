import { Component, input, output, effect, ElementRef, ViewEncapsulation } from '@angular/core';
import type { ConversationMessage } from '@shared/index';
import { MarkdownPipe } from './markdown.pipe';
import { RunButtonDirective } from './run-button.directive';

/** Same shape as `ConversationMessage` in `typings.d.ts` (single source for save/load). */
export type ChatMessage = ConversationMessage;

@Component({
  selector: 'app-chat-box',
  imports: [MarkdownPipe, RunButtonDirective],
  templateUrl: './chat-box.html',
  styleUrl: './chat-box.css',
  encapsulation: ViewEncapsulation.None
})
export class ChatBox {
  readonly messages = input<ChatMessage[]>([]);
  readonly loading = input(false);
  /** True while a workspace tool is executing (processing spinner uses blue vs orange). */
  readonly processingToolsActive = input(false);
  /** Optional sub-label from backend (e.g. tool name and path) while tools run. */
  readonly processingToolHint = input('');
  /** Fetching TTS audio for read-aloud (shown on the latest assistant bubble). */
  readonly ttsLoading = input(false);
  readonly streamingText = input('');
  readonly fontSize = input(0.9);
  readonly sendResponse = output<string>();

  constructor(private el: ElementRef<HTMLElement>) {
    effect(() => {
      this.messages();
      this.loading();
      this.processingToolsActive();
      this.processingToolHint();
      this.ttsLoading();
      setTimeout(() => this.scrollToBottom());
    });

    effect(() => {
      this.streamingText();
      setTimeout(() => this.scrollStreamingPre());
    });

    effect(() => {
      const isLoading = this.loading();
      const streaming = this.streamingText();
      if (!isLoading && !streaming) {
        setTimeout(() => this.scrollToBottom());
      }
    });

    effect(() => {
      this.el.nativeElement.style.setProperty('--chat-font-size', `${this.fontSize()}rem`);
    });

    this.el.nativeElement.addEventListener('send-response', ((event: CustomEvent) => {
      this.sendResponse.emit(event.detail);
    }) as EventListener);
  }

  private scrollToBottom(): void {
    const box = this.el.nativeElement.querySelector('.chat-box');
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }

  private scrollStreamingPre(): void {
    const pre = this.el.nativeElement.querySelector('.streaming-pre');
    if (pre) {
      pre.scrollTop = pre.scrollHeight;
    }
  }
  public processingText(): string {
    if (!this.processingToolsActive()) {
      return 'Thinking...';
    }
    const hint = this.processingToolHint().trim();
    return hint ? `Working: ${hint}` : 'Awaiting response';
  }
}
