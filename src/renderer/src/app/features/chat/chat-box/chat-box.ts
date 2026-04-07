import {
  Component,
  computed,
  effect,
  inject,
  input,
  OnDestroy,
  output,
  untracked,
  ElementRef,
  ViewEncapsulation,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { ConversationMessage, PlannerProgress, StreamPart } from '@shared/index';
import {
  primaryStreamPartsForDisplay,
  streamPlainOneLine,
} from '@shared/index';
import { CopyConfirmComponent } from '../../diff/copy-confirm/copy-confirm';
import { DeleteConfirmComponent } from '../../diff/delete-confirm/delete-confirm';
import { DiffApplyComponent } from '../../diff/diff-apply/diff-apply';
import { MarkdownPipe } from './markdown.pipe';
import { PlannerTasksComponent } from './planner-tasks/planner-tasks';
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
type UserMessage = Extract<ChatMessage, { role: 'user' }>;
type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;
type ChainMessage = Extract<ChatMessage, { role: 'chain' }>;
type ArtifactMessage = Extract<ChatMessage, { role: 'diff' | 'copy_confirm' | 'delete_confirm' }>;

export interface ToolChainGroup {
  key: string;
  rows: ChainMessage[];
  toolCallCount: number;
}

export type ChatDisplayRow =
  | { kind: 'user'; msg: UserMessage }
  | {
      kind: 'assistant-turn';
      assistant: AssistantMessage | null;
      chainGroups: ToolChainGroup[];
      artifacts: ArtifactMessage[];
    };

function buildToolChainGroup(rows: ChainMessage[], index: number): ToolChainGroup {
  const visibleRows = rows.filter((row) => row.source === 'tool');
  return {
    key: rows[0]?.statusId ?? `tool-chain-${index}`,
    rows: visibleRows,
    toolCallCount: visibleRows.length,
  };
}

function isNestedPlannerChainGroup(group: ToolChainGroup): boolean {
  return group.rows.some((row) => {
    const tag = row.streamTag?.trim() ?? '';
    return tag === 'planner' || tag === 'planning' || tag.startsWith('spec-');
  });
}

export function filterLiveToolChainGroups(
  groups: ToolChainGroup[],
  planner: PlannerProgress | null,
): ToolChainGroup[] {
  const planReady = planner?.planReady ?? false;
  return groups.filter((group) => group.rows.length > 0 && (planReady || !isNestedPlannerChainGroup(group)));
}

export function buildChatDisplayRows(messages: ChatMessage[]): ChatDisplayRow[] {
  const rows: ChatDisplayRow[] = [];
  const pendingArtifacts: ArtifactMessage[] = [];
  const pendingChainGroups: ToolChainGroup[] = [];
  let pendingChainRows: ChainMessage[] = [];
  let chainGroupIndex = 0;

  const flushChainGroup = (): void => {
    if (pendingChainRows.length === 0) return;
    const group = buildToolChainGroup([...pendingChainRows], chainGroupIndex++);
    pendingChainRows = [];
    if (group.rows.length === 0) return;
    pendingChainGroups.push(group);
  };

  const flushPendingAssistantTurn = (): void => {
    flushChainGroup();
    if (pendingChainGroups.length === 0 && pendingArtifacts.length === 0) return;
    rows.push({
      kind: 'assistant-turn',
      assistant: null,
      chainGroups: [...pendingChainGroups],
      artifacts: [...pendingArtifacts],
    });
    pendingChainGroups.length = 0;
    pendingArtifacts.length = 0;
  };

  for (const msg of messages) {
    if (msg.role === 'user') {
      flushPendingAssistantTurn();
      rows.push({ kind: 'user', msg });
      continue;
    }
    if (msg.role === 'chain') {
      pendingChainRows.push(msg);
      continue;
    }
    if (msg.role === 'diff' || msg.role === 'copy_confirm' || msg.role === 'delete_confirm') {
      flushChainGroup();
      pendingArtifacts.push(msg);
      continue;
    }
    flushChainGroup();
    rows.push({
      kind: 'assistant-turn',
      assistant: msg,
      chainGroups: [...pendingChainGroups],
      artifacts: [...pendingArtifacts],
    });
    pendingChainGroups.length = 0;
    pendingArtifacts.length = 0;
  }

  flushPendingAssistantTurn();
  return rows;
}

@Component({
  selector: 'app-chat-box',
  imports: [
    MarkdownPipe,
    RunButtonDirective,
    DiffApplyComponent,
    CopyConfirmComponent,
    DeleteConfirmComponent,
    PlannerTasksComponent,
    NgxSpinnerComponent,
  ],
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
  readonly processingToolsActive = input(false);
  readonly ttsLoading = input(false);
  readonly streamingParts = input<StreamPart[]>([]);
  readonly livePlannerProgress = input<PlannerProgress | null>(null);
  readonly fontSize = input(0.9);
  readonly sendResponse = output<string>();
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
  readonly copyReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();

  readonly transcriptRows = computed(() => buildChatDisplayRows(this.messages()));

  readonly persistedRows = computed(() => {
    const rows = this.transcriptRows();
    if (!this.loading()) return rows;
    const last = rows.at(-1);
    if (last?.kind === 'assistant-turn' && !last.assistant) {
      return rows.slice(0, -1);
    }
    return rows;
  });

  readonly primaryStreamParts = computed(() =>
    primaryStreamPartsForDisplay(this.streamingParts(), null),
  );

  readonly primaryStreamPlainDisplay = computed(() =>
    streamPlainOneLine(this.primaryStreamParts().map((p) => p.text).join('')),
  );

  readonly showStreamingPrimaryCursor = computed(
    () => this.loading() && this.primaryStreamParts().some((p) => p.text.length > 0),
  );

  readonly liveTurn = computed<Extract<ChatDisplayRow, { kind: 'assistant-turn' }> | null>(() => {
    if (!this.loading()) return null;
    const rows = this.transcriptRows();
    const last = rows.at(-1);
    const trailingTurn = last?.kind === 'assistant-turn' && !last.assistant ? last : null;
    const hasLiveContent =
      trailingTurn !== null ||
      this.livePlannerProgress() !== null ||
      this.primaryStreamPlainDisplay().length > 0 ||
      this.processingToolsActive();
    if (!hasLiveContent) return null;
    return trailingTurn ?? {
      kind: 'assistant-turn',
      assistant: null,
      chainGroups: [],
      artifacts: [],
    };
  });

  readonly liveVisibleChainGroups = computed(() => {
    const liveTurn = this.liveTurn();
    if (!liveTurn) return [];
    return filterLiveToolChainGroups(liveTurn.chainGroups, this.livePlannerProgress());
  });

  constructor(private el: ElementRef<HTMLElement>) {
    effect(() => {
      this.messages();
      this.loading();
      this.processingToolsActive();
      this.ttsLoading();
      setTimeout(() => this.scrollToBottom());
    });

    effect(() => {
      this.streamingParts();
      setTimeout(() => this.scrollToBottom());
    });

    effect(() => {
      this.livePlannerProgress();
      setTimeout(() => this.scrollToBottom());
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

  toolChainSummary(group: ToolChainGroup): string {
    if (group.toolCallCount > 0) {
      return `${group.toolCallCount} tool call${group.toolCallCount === 1 ? '' : 's'}`;
    }
    return `${group.rows.length} update${group.rows.length === 1 ? '' : 's'}`;
  }
}
