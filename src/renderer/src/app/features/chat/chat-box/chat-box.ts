import {
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  ElementRef,
  ViewEncapsulation,
} from '@angular/core';
import type { ConversationMessage, ClaraAgentMode, LlmAgentRole } from '@shared/index';
import { claraModeFromLlmRole } from '@shared/index';
import { claraProcessingPhraseForMode } from '../../../core/clara-synonyms';
import { DiffApplyComponent } from '../../diff/diff-apply/diff-apply';
import { MarkdownPipe } from './markdown.pipe';
import { RunButtonDirective } from './run-button.directive';

/** Same shape as `ConversationMessage` in `typings.d.ts` (single source for save/load). */
export type ChatMessage = ConversationMessage;

@Component({
  selector: 'app-chat-box',
  imports: [MarkdownPipe, RunButtonDirective, DiffApplyComponent],
  templateUrl: './chat-box.html',
  styleUrl: './chat-box.css',
  encapsulation: ViewEncapsulation.None,
})
export class ChatBox {
  readonly messages = input<ChatMessage[]>([]);
  readonly conversationId = input<string | null>(null);
  readonly loading = input(false);
  /** True while a workspace tool is executing (processing spinner uses blue vs orange). */
  readonly processingToolsActive = input(false);
  /** Optional sub-label from backend (e.g. tool name and path) while tools run. */
  readonly processingToolHint = input('');
  /** Manager vs Worker tier from backend while the model thinks (single-agent stays null → CLARA_AGENT). */
  readonly processingAgentRole = input<LlmAgentRole | null>(null);
  /** Fetching TTS audio for read-aloud (shown on the latest assistant bubble). */
  readonly ttsLoading = input(false);
  readonly streamingText = input('');
  /** Read-tool stream (separate from model tokens; not persisted on the assistant message). */
  readonly toolReadStreamText = input('');
  readonly fontSize = input(0.9);
  readonly sendResponse = output<string>();
  /** After diff review, parent updates transcript metadata (and save). */
  readonly diffReviewFinished = output<{
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  /** Internal tier for layout / data attributes (CLARA_AGENT | CLARA_MANAGER | CLARA_WORKER). */
  readonly claraMode = computed<ClaraAgentMode>(() => claraModeFromLlmRole(this.processingAgentRole()));

  /**
   * Processing-row phrase: exactly `Clara`, or `Clara <synonym>` from Datamuse for manager/worker.
   */
  readonly processingPhraseLabel = signal('Clara');

  private synonymRequestGen = 0;

  constructor(private el: ElementRef<HTMLElement>) {
    effect(() => {
      const loading = this.loading();
      const mode = this.claraMode();
      if (!loading) {
        untracked(() => this.processingPhraseLabel.set('Clara'));
        return;
      }
      if (mode === 'CLARA_AGENT') {
        untracked(() => this.processingPhraseLabel.set('Clara'));
        return;
      }
      const gen = ++this.synonymRequestGen;
      void claraProcessingPhraseForMode(mode).then((phrase) => {
        untracked(() => {
          if (gen !== this.synonymRequestGen) return;
          if (!this.loading()) return;
          if (this.claraMode() !== mode) return;
          this.processingPhraseLabel.set(phrase);
        });
      });
    });

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
      this.toolReadStreamText();
      setTimeout(() => this.scrollToolReadPre());
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

  private scrollToolReadPre(): void {
    const pre = this.el.nativeElement.querySelector('.tool-read-stream-pre');
    if (pre) {
      pre.scrollTop = pre.scrollHeight;
    }
  }

  /** Visible author line (always Clara; mode is in {@link claraMode} / pill). */
  streamAuthorDisplay(): string {
    return 'Clara';
  }

  /** Small badge next to the author when manager/worker tier is active. */
  claraModePill(): string | null {
    const m = this.claraMode();
    if (m === 'CLARA_MANAGER') return 'Manager';
    if (m === 'CLARA_WORKER') return 'Worker';
    return null;
  }

  public chainPillText(msg: ChatMessage): string {
    if (msg.role !== 'chain') {
      return '';
    }
    if (msg.agentRole === 'manager') {
      return 'MANAGER';
    }
    if (msg.agentRole === 'worker') {
      return 'WORKER';
    }
    return msg.source === 'tool' ? 'TOOL' : 'AGENT';
  }
}
