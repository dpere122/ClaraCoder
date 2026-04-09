import {
  Component,
  computed,
  effect,
  inject,
  Injector,
  input,
  OnDestroy,
  output,
  untracked,
  ElementRef,
  ViewEncapsulation,
  viewChild,
  signal,
  afterNextRender,
} from '@angular/core';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { ConversationMessage, PlannerProgress, StreamPart } from '@shared/index';
import {
  delegatedStreamPartsForDisplay,
  isClaraOuterBriefStreamTag,
  isShellStyleToolStreamTag,
  primaryStreamPartsForDisplay,
  streamPlainOneLine,
} from '@shared/index';
import { AcceptCommandComponent } from '../../diff/accept-command/accept-command';
import { CopyConfirmComponent } from '../../diff/copy-confirm/copy-confirm';
import { DeleteConfirmComponent } from '../../diff/delete-confirm/delete-confirm';
import { DiffApplyComponent } from '../../diff/diff-apply/diff-apply';
import { MarkdownPipe } from './markdown.pipe';
import { PlannerTasksComponent } from './planner-tasks/planner-tasks';
import { DelegatedShellTerminalComponent } from './delegated-shell-terminal/delegated-shell-terminal';
import { RunButtonDirective } from './run-button.directive';
import { TalkUiState } from '../../../core/talk-ui-state';
import {
  CHAT_MIN_FALLBACK_ROW,
  CHAT_VIRTUAL_PIXEL_BUFFER,
  CHAT_VIRTUAL_THRESHOLD,
  computeVirtualRange,
  estimateChatRowHeight,
  sumHeights,
} from './chat-box-virtual';

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

/** Shown in the live processing row while tools are active; index chosen when tool phase starts. */
export const TOOL_BUILDING_SYNONYMS = [
  'assembling',
  'constructing',
  'compiling',
  'crafting',
  'fabricating',
  'forging',
  'generating',
  'producing',
  'shaping',
  'structuring',
  'erecting',
  'forming',
] as const;

export function isScrollWorthyAppendMessage(m: ChatMessage): boolean {
  return (
    m.role === 'user' ||
    m.role === 'assistant' ||
    m.role === 'chain' ||
    m.role === 'diff' ||
    m.role === 'delete_confirm' ||
    m.role === 'copy_confirm' ||
    m.role === 'accept_command'
  );
}

/** Small stable hash for synonym index (FNV-1a 32-bit). */
function hashToUint(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Same shape as `ConversationMessage` in `typings.d.ts` (single source for save/load). */
export type ChatMessage = ConversationMessage;
type UserMessage = Extract<ChatMessage, { role: 'user' }>;
type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;
type ChainMessage = Extract<ChatMessage, { role: 'chain' }>;
type ArtifactMessage = Extract<ChatMessage, { role: 'diff' | 'accept_command' | 'copy_confirm' | 'delete_confirm' }>;

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
  const visibleRows = rows.filter(
    (row) => row.source === 'tool' || isClaraOuterBriefStreamTag(row.streamTag),
  );
  return {
    key: rows[0]?.statusId ?? `tool-chain-${index}`,
    rows: visibleRows,
    toolCallCount: visibleRows.filter((row) => row.source === 'tool').length,
  };
}

function isNestedPlannerChainGroup(group: ToolChainGroup): boolean {
  return group.rows.some((row) => {
    const tag = row.streamTag?.trim() ?? '';
    return (
      tag === 'planner' ||
      tag === 'planning' ||
      isClaraOuterBriefStreamTag(row.streamTag) ||
      tag.startsWith('spec-')
    );
  });
}

function isClaraOnlyToolChainGroup(group: ToolChainGroup): boolean {
  return (
    group.rows.length > 0 && group.rows.every((row) => isClaraOuterBriefStreamTag(row.streamTag))
  );
}

/** Nested tool/clara rows stay hidden until the planner checklist exists, unless there is no planner UI at all. */
function nestedGroupWaitsForPlanReady(group: ToolChainGroup, planner: PlannerProgress | null): boolean {
  if (!isNestedPlannerChainGroup(group)) {
    return false;
  }
  if (planner == null && isClaraOnlyToolChainGroup(group)) {
    return false;
  }
  return true;
}

export function filterLiveToolChainGroups(
  groups: ToolChainGroup[],
  planner: PlannerProgress | null,
): ToolChainGroup[] {
  const planReady = planner?.planReady ?? false;
  return groups.filter(
    (group) =>
      group.rows.length > 0 &&
      (!nestedGroupWaitsForPlanReady(group, planner) || planReady),
  );
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
    if (msg.role === 'accept_command') {
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
    AcceptCommandComponent,
    CopyConfirmComponent,
    DeleteConfirmComponent,
    PlannerTasksComponent,
    NgxSpinnerComponent,
    DelegatedShellTerminalComponent,
  ],
  templateUrl: './chat-box.html',
  styleUrl: './chat-box.css',
  encapsulation: ViewEncapsulation.None,
})
export class ChatBox implements OnDestroy {
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);
  readonly talkUi = inject(TalkUiState);

  /** Template helper: nested workspace handoff rows for outer Clara (stream tag `clara`). */
  readonly isClaraOuterBriefTrail = (trail: ChainMessage) => isClaraOuterBriefStreamTag(trail.streamTag);

  readonly chatScroll = viewChild<ElementRef<HTMLElement>>('chatScroll');

  /** Measured or estimated height per persisted row (index-aligned with persistedRows). */
  private readonly rowHeights = signal<number[]>([]);
  private readonly scrollTopSig = signal(0);
  private readonly viewportHeightSig = signal(0);
  private lastConversationId: string | null = null;
  private scrollRaf = 0;
  private measurePassScheduled = false;
  private scrollToBottomRaf = 0;
  /** Tracks transcript length per conversation for append-only auto-scroll. */
  private scrollTrackedMsgLen = 0;
  private scrollTrackedConvId: string | null | undefined = undefined;
  private scrollSmoothDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private wasProcessingToolsActive = false;
  private readonly toolPhaseSynonymIndex = signal(0);
  private chatDestroyed = false;
  private convScrollTimeout: ReturnType<typeof setTimeout> | null = null;

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
  readonly acceptCommandFinished = output<{
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

  /**
   * Windowed transcript: only `slots` are in the DOM when the conversation is long.
   * Spacers preserve scroll extent using measured or estimated row heights.
   */
  readonly virtualWindow = computed(() => {
    const rows = this.persistedRows();
    const n = rows.length;
    const h = this.rowHeights();
    const st = this.scrollTopSig();
    const vh = this.viewportHeightSig() || 480;

    if (n < CHAT_VIRTUAL_THRESHOLD || h.length !== n) {
      return {
        slots: rows.map((row, index) => ({ index, row })),
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }
    const { start, end } = computeVirtualRange(h, st, vh, CHAT_VIRTUAL_PIXEL_BUFFER, CHAT_MIN_FALLBACK_ROW);
    const slots = rows.slice(start, end).map((row, i) => ({ index: start + i, row }));
    return {
      slots,
      topSpacer: sumHeights(h, 0, start),
      bottomSpacer: sumHeights(h, end, n),
    };
  });

  readonly primaryStreamParts = computed(() =>
    primaryStreamPartsForDisplay(this.streamingParts(), null),
  );

  readonly delegatedStreamParts = computed(() =>
    delegatedStreamPartsForDisplay(this.streamingParts(), null),
  );

  readonly shellDelegatedStreamParts = computed(() =>
    this.delegatedStreamParts().filter((p) => isShellStyleToolStreamTag(p.streamTag)),
  );

  readonly otherDelegatedStreamParts = computed(() =>
    this.delegatedStreamParts().filter((p) => !isShellStyleToolStreamTag(p.streamTag)),
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
    // Always show the live row while loading so the processing ngx-spinners stay mounted and visible
    // during the gap before the first stream chunk, planner update, or tool status.
    return (
      trailingTurn ?? {
        kind: 'assistant-turn',
        assistant: null,
        chainGroups: [],
        artifacts: [],
      }
    );
  });

  readonly liveVisibleChainGroups = computed(() => {
    const liveTurn = this.liveTurn();
    if (!liveTurn) return [];
    return filterLiveToolChainGroups(liveTurn.chainGroups, this.livePlannerProgress());
  });

  readonly processingBubbleLabel = computed(() => {
    if (!this.loading()) {
      return 'thinking';
    }
    if (this.processingToolsActive()) {
      return TOOL_BUILDING_SYNONYMS[this.toolPhaseSynonymIndex() % TOOL_BUILDING_SYNONYMS.length]!;
    }
    return 'thinking';
  });

  constructor(private el: ElementRef<HTMLElement>) {
    afterNextRender(
      () => {
        const elScroll = this.chatScroll()?.nativeElement;
        if (!elScroll) return;
        this.viewportHeightSig.set(elScroll.clientHeight);
        new ResizeObserver(() => {
          this.viewportHeightSig.set(elScroll.clientHeight);
        }).observe(elScroll);
      },
      { injector: this.inj },
    );

    effect(() => {
      const id = this.conversationId();
      const rows = this.persistedRows();
      const fs = this.fontSize();
      untracked(() => {
        if (id !== this.lastConversationId) {
          this.lastConversationId = id;
          this.rowHeights.set(rows.map((r) => estimateChatRowHeight(r, fs)));
          return;
        }
        const prev = this.rowHeights();
        if (rows.length < prev.length) {
          this.rowHeights.set(rows.map((r) => estimateChatRowHeight(r, fs)));
          return;
        }
        this.rowHeights.set(
          rows.map((r, i) => (i < prev.length ? prev[i]! : estimateChatRowHeight(r, fs))),
        );
      });
    });

    effect(() => {
      const id = this.conversationId();
      const msgs = this.messages();
      untracked(() => {
        const convChanged =
          this.scrollTrackedConvId === undefined ? true : this.scrollTrackedConvId !== id;
        if (convChanged) {
          this.scrollTrackedConvId = id;
          this.scrollTrackedMsgLen = msgs.length;
          if (this.convScrollTimeout != null) {
            clearTimeout(this.convScrollTimeout);
          }
          this.convScrollTimeout = setTimeout(() => {
            this.convScrollTimeout = null;
            if (this.chatDestroyed) {
              return;
            }
            this.scrollToBottom('instant');
            this.scheduleMeasureVisibleRows();
          });
          return;
        }
        if (msgs.length > this.scrollTrackedMsgLen) {
          const added = msgs.slice(this.scrollTrackedMsgLen);
          if (added.some(isScrollWorthyAppendMessage)) {
            this.debouncedSmoothScrollToBottom();
          }
        }
        this.scrollTrackedMsgLen = msgs.length;
      });
    });

    effect(() => {
      this.virtualWindow();
      untracked(() => this.scheduleMeasureVisibleRows());
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
        if (loading && tools && !this.wasProcessingToolsActive) {
          const chainN = this.messages().filter((m) => m.role === 'chain').length;
          const key = `${this.conversationId() ?? ''}:${chainN}`;
          this.toolPhaseSynonymIndex.set(hashToUint(key) % TOOL_BUILDING_SYNONYMS.length);
        }
        this.wasProcessingToolsActive = tools;
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
    this.chatDestroyed = true;
    if (this.convScrollTimeout != null) {
      clearTimeout(this.convScrollTimeout);
      this.convScrollTimeout = null;
    }
    if (this.scrollSmoothDebounceTimer != null) {
      clearTimeout(this.scrollSmoothDebounceTimer);
      this.scrollSmoothDebounceTimer = null;
    }
    void this.ngxSpinner.hide(SPINNER_CHAT_TOOL);
    void this.ngxSpinner.hide(SPINNER_CHAT_THINK);
    void this.ngxSpinner.hide(SPINNER_CHAT_TTS);
    void this.ngxSpinner.hide(SPINNER_TALK_REC);
    void this.ngxSpinner.hide(SPINNER_TALK_TX);
  }

  onChatScroll(): void {
    cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = requestAnimationFrame(() => {
      const box = this.chatScroll()?.nativeElement;
      if (!box) return;
      this.scrollTopSig.set(box.scrollTop);
      this.viewportHeightSig.set(box.clientHeight);
      this.scheduleMeasureVisibleRows();
    });
  }

  isLastPersistedRow(index: number): boolean {
    return index === this.persistedRows().length - 1;
  }

  private scheduleMeasureVisibleRows(): void {
    if (this.chatDestroyed || this.measurePassScheduled) return;
    this.measurePassScheduled = true;
    afterNextRender(
      {
        read: () => {
          this.measurePassScheduled = false;
          if (this.chatDestroyed) {
            return;
          }
          const root = this.chatScroll()?.nativeElement;
          if (!root) return;
          const rowsLen = this.persistedRows().length;
          for (const wrap of root.querySelectorAll<HTMLElement>('[data-chat-row]')) {
            const idx = Number(wrap.dataset['chatRow']);
            if (!Number.isFinite(idx) || idx < 0 || idx >= rowsLen) continue;
            const measured = wrap.offsetHeight;
            if (measured < 8) continue;
            this.rowHeights.update((arr) => {
              if (idx >= arr.length) return arr;
              if (Math.abs((arr[idx] ?? 0) - measured) < 2) return arr;
              const next = [...arr];
              next[idx] = measured;
              return next;
            });
          }
        },
      },
      { injector: this.inj },
    );
  }

  private debouncedSmoothScrollToBottom(): void {
    if (this.scrollSmoothDebounceTimer != null) {
      clearTimeout(this.scrollSmoothDebounceTimer);
    }
    this.scrollSmoothDebounceTimer = setTimeout(() => {
      this.scrollSmoothDebounceTimer = null;
      if (this.chatDestroyed) {
        return;
      }
      this.scrollToBottom('smooth');
    }, 80);
  }

  private scrollToBottom(behavior: ScrollBehavior): void {
    if (this.chatDestroyed) {
      return;
    }
    cancelAnimationFrame(this.scrollToBottomRaf);
    this.scrollToBottomRaf = requestAnimationFrame(() => {
      if (this.chatDestroyed) {
        return;
      }
      const box = this.chatScroll()?.nativeElement ?? this.el.nativeElement.querySelector('.chat-box');
      if (box instanceof HTMLElement) {
        const top = box.scrollHeight;
        try {
          box.scrollTo({ top, behavior });
        } catch {
          box.scrollTop = top;
        }
        this.scrollTopSig.set(box.scrollTop);
      }
      this.scheduleMeasureVisibleRows();
    });
  }

  toolChainSummary(group: ToolChainGroup): string {
    const claraN = group.rows.filter((r) => isClaraOuterBriefStreamTag(r.streamTag)).length;
    const toolN = group.toolCallCount;
    if (claraN > 0 && toolN > 0) {
      return `${toolN} tool call${toolN === 1 ? '' : 's'} · ${claraN} Clara update${claraN === 1 ? '' : 's'}`;
    }
    if (claraN > 0) {
      return `${claraN} Clara update${claraN === 1 ? '' : 's'}`;
    }
    if (toolN > 0) {
      return `${toolN} tool call${toolN === 1 ? '' : 's'}`;
    }
    return `${group.rows.length} update${group.rows.length === 1 ? '' : 's'}`;
  }
}
