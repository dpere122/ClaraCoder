import {
  Component,
  computed,
  effect,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  ElementRef,
  ViewEncapsulation,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { ConversationMessage, ClaraAgentMode, LlmAgentRole, StreamPart } from '@shared/index';
import {
  claraModeFromLlmRole,
  delegatedStreamPartsForDisplay,
  primaryStreamPartsForDisplay,
  streamPlainOneLine,
} from '@shared/index';
import { claraProcessingPhraseForMode } from '../../../core/clara-synonyms';
import { DeleteConfirmComponent } from '../../diff/delete-confirm/delete-confirm';
import { DiffApplyComponent } from '../../diff/diff-apply/diff-apply';
import { MarkdownPipe } from './markdown.pipe';
import { RunButtonDirective } from './run-button.directive';
import { TalkUiState } from '../../../core/talk-ui-state';

const SPINNER_CHAT_TOOL = 'chat-tool';
const SPINNER_CHAT_THINK = 'chat-think';
const SPINNER_CHAT_TTS = 'chat-tts';
const SPINNER_TALK_REC = 'chat-talk-rec';
const SPINNER_TALK_TX = 'chat-talk-tx';

const INLINE_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--bs-secondary-color)',
};

/** Same shape as `ConversationMessage` in `typings.d.ts` (single source for save/load). */
export type ChatMessage = ConversationMessage;

/** Collapse adjacent segments with the same tag so the delegated UI does not stack one block per chunk. */
function mergeAdjacentStreamPartsByTag(parts: StreamPart[]): StreamPart[] {
  const out: StreamPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.streamTag === p.streamTag) {
      out[out.length - 1] = { ...last, text: last.text + p.text };
    } else {
      out.push({ streamTag: p.streamTag, label: p.label, text: p.text });
    }
  }
  return out;
}

@Component({
  selector: 'app-chat-box',
  imports: [MarkdownPipe, RunButtonDirective, DiffApplyComponent, DeleteConfirmComponent, NgxSpinnerComponent],
  templateUrl: './chat-box.html',
  styleUrl: './chat-box.css',
  encapsulation: ViewEncapsulation.None,
})
export class ChatBox implements OnDestroy {
  private readonly ngxSpinner = inject(NgxSpinnerService);
  readonly talkUi = inject(TalkUiState);

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
  readonly streamingParts = input<StreamPart[]>([]);
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
  readonly deleteReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  /** Tier for streaming chrome (header pill, `data-clara-mode`, processing-row synonym). */
  readonly claraModeForProcessingUi = computed<ClaraAgentMode>(() =>
    claraModeFromLlmRole(this.processingAgentRole()),
  );

  /** Processing-row phrase: exactly `Clara`, or `Clara <synonym>` from Datamuse when a tier requests it. */
  readonly processingPhraseLabel = signal('Clara');

  /** Outer Clara tokens in the main streaming area (`agent`, legacy `mgr`). */
  readonly primaryStreamParts = computed(() =>
    primaryStreamPartsForDisplay(this.streamingParts(), this.processingAgentRole()),
  );

  /** Nested planning, specialists, legacy `worker` — collapsible (same-tag chunks merged for layout). */
  readonly delegatedStreamParts = computed(() =>
    mergeAdjacentStreamPartsByTag(
      delegatedStreamPartsForDisplay(this.streamingParts(), this.processingAgentRole()),
    ),
  );

  /** Shown when delegated work is streaming but the manager has not emitted text yet. */
  readonly showPrimaryStreamPlaceholder = computed(() => {
    const primary = this.primaryStreamParts();
    const delegated = this.delegatedStreamParts();
    const primaryTextEmpty = primary.every((p) => !p.text);
    const delegatedHasText = delegated.some((p) => p.text.length > 0);
    return primaryTextEmpty && delegatedHasText;
  });

  /** Primary token stream as one plain line (no markdown, no visible newlines). */
  readonly primaryStreamPlainDisplay = computed(() =>
    streamPlainOneLine(this.primaryStreamParts().map((p) => p.text).join('')),
  );

  readonly toolReadStreamPlainDisplay = computed(() => streamPlainOneLine(this.toolReadStreamText()));

  /** Blinking cursor after the live plain line while tokens arrive. */
  readonly showStreamingPrimaryCursor = computed(
    () => this.loading() && this.primaryStreamParts().some((p) => p.text.length > 0),
  );

  private synonymRequestGen = 0;

  /** One-line plain preview for template (delegated streams, tool read). */
  plainOneLine(text: string): string {
    return streamPlainOneLine(text);
  }

  constructor(private el: ElementRef<HTMLElement>) {
    effect(() => {
      const loading = this.loading();
      const mode = this.claraModeForProcessingUi();
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
          if (this.claraModeForProcessingUi() !== mode) return;
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
      this.streamingParts();
      setTimeout(() => this.scrollStreamingPre());
    });

    effect(() => {
      this.toolReadStreamText();
      setTimeout(() => this.scrollToolReadPre());
    });

    effect(() => {
      const isLoading = this.loading();
      const parts = this.streamingParts();
      const streaming = parts.some((p) => p.text.length > 0);
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

    effect(() => {
      const loading = this.loading();
      const tools = this.processingToolsActive();
      untracked(() => {
        if (!loading) {
          void this.ngxSpinner.hide(SPINNER_CHAT_TOOL);
          void this.ngxSpinner.hide(SPINNER_CHAT_THINK);
          return;
        }
        if (tools) {
          void this.ngxSpinner.show(SPINNER_CHAT_TOOL, { ...INLINE_SPINNER, type: 'ball-triangle-path' });
          void this.ngxSpinner.hide(SPINNER_CHAT_THINK);
        } else {
          void this.ngxSpinner.hide(SPINNER_CHAT_TOOL);
          void this.ngxSpinner.show(SPINNER_CHAT_THINK, { ...INLINE_SPINNER, type: 'ball-atom' });
        }
      });
    });

    effect(() => {
      const tts = this.ttsLoading();
      untracked(() => {
        if (tts) {
          void this.ngxSpinner.show(SPINNER_CHAT_TTS, { ...INLINE_SPINNER, type: 'line-scale' });
        } else {
          void this.ngxSpinner.hide(SPINNER_CHAT_TTS);
        }
      });
    });

    effect(() => {
      const cap = this.talkUi.capturing();
      const tx = this.talkUi.transcribing();
      untracked(() => {
        if (cap) {
          void this.ngxSpinner.show(SPINNER_TALK_REC, { ...INLINE_SPINNER, type: 'ball-clip-rotate-pulse' });
          void this.ngxSpinner.hide(SPINNER_TALK_TX);
        } else if (tx) {
          void this.ngxSpinner.hide(SPINNER_TALK_REC);
          void this.ngxSpinner.show(SPINNER_TALK_TX, { ...INLINE_SPINNER, type: 'ball-pulse-sync' });
        } else {
          void this.ngxSpinner.hide(SPINNER_TALK_REC);
          void this.ngxSpinner.hide(SPINNER_TALK_TX);
        }
      });
    });
  }

  ngOnDestroy(): void {
    void this.ngxSpinner.hide(SPINNER_CHAT_TOOL);
    void this.ngxSpinner.hide(SPINNER_CHAT_THINK);
    void this.ngxSpinner.hide(SPINNER_CHAT_TTS);
    void this.ngxSpinner.hide(SPINNER_TALK_REC);
    void this.ngxSpinner.hide(SPINNER_TALK_TX);
  }

  private scrollToBottom(): void {
    const box = this.el.nativeElement.querySelector('.chat-box');
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }

  private scrollStreamingPre(): void {
    const scrollables = this.el.nativeElement.querySelectorAll('.streaming-delegated-plain, .tool-read-stream-plain');
    const el = scrollables.item(scrollables.length - 1);
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  private scrollToolReadPre(): void {
    const el = this.el.nativeElement.querySelector('.tool-read-stream-plain');
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Visible author line (always Clara; mode is in {@link claraModeForProcessingUi} / pill). */
  streamAuthorDisplay(): string {
    return 'Clara';
  }

  /** Role pill (legacy chain rows may still reference manager/worker). */
  claraModePill(): string | null {
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
