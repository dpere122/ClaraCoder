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
import type { ConversationMessage, StreamPart } from '@shared/index';
import {
  auxiliaryTimelineEmbedsToolStatus,
  isClaraOuterBriefStreamTag,
  joinPrimaryAssistantStreamText,
  multiplexAuxiliaryStreamTimeline,
  persistedAuxiliaryStreamTimeline,
  primaryStreamPartsForDisplay,
} from '@shared/index';
import { AcceptCommandComponent } from '../../diff/accept-command/accept-command';
import { CopyConfirmComponent } from '../../diff/copy-confirm/copy-confirm';
import { DeleteConfirmComponent } from '../../diff/delete-confirm/delete-confirm';
import { DiffApplyComponent } from '../../diff/diff-apply/diff-apply';
import { MarkdownPipe } from './markdown.pipe';
import {
  AuxiliaryStreamPanelComponent,
  DEFAULT_AUXILIARY_STREAM_PANEL_TITLE,
  PERSISTED_AUXILIARY_STREAM_PANEL_TITLE,
} from './auxiliary-stream-panel/auxiliary-stream-panel';
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

/** Pixels from the bottom of the chat viewport to treat as “pinned” for follow-final-message behavior. */
const SCROLL_BOTTOM_PIN_THRESHOLD_PX = 48;

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

/** Review / confirmation cards (HITL): always scroll into view, including while a reply is still streaming. */
export function isHitlActivationMessage(m: ChatMessage): boolean {
  return (
    m.role === 'diff' ||
    m.role === 'delete_confirm' ||
    m.role === 'copy_confirm' ||
    m.role === 'accept_command'
  );
}

/** HITL card still awaiting user action (blocks the live streaming row until resolved). */
export function isPendingHitlArtifact(m: ArtifactMessage): boolean {
  return (m.reviewStatus ?? 'pending') === 'pending';
}

export function turnHasPendingHitlArtifacts(artifacts: readonly ArtifactMessage[]): boolean {
  return artifacts.some(isPendingHitlArtifact);
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

export function filterLiveToolChainGroups(groups: ToolChainGroup[]): ToolChainGroup[] {
  return groups.filter((group) => group.rows.length > 0);
}

/** Drop `source: tool` chain rows when those tools are already shown inside the auxiliary timeline. */
function stripToolChainRowsFromChainGroups(groups: ToolChainGroup[]): ToolChainGroup[] {
  return groups
    .map((g) => {
      const kept = g.rows.filter((r) => r.source !== 'tool');
      const visibleRows = kept.filter(
        (row) => row.source === 'tool' || isClaraOuterBriefStreamTag(row.streamTag),
      );
      return {
        ...g,
        rows: visibleRows,
        toolCallCount: visibleRows.filter((row) => row.source === 'tool').length,
      };
    })
    .filter((g) => g.rows.length > 0);
}

/** When Clara updates are promoted into the reasoning panel title, avoid showing the same card twice. */
function stripClaraChainRowsFromChainGroups(groups: ToolChainGroup[]): ToolChainGroup[] {
  return groups
    .map((g) => {
      const rows = g.rows.filter((row) => !isClaraOuterBriefStreamTag(row.streamTag));
      return {
        ...g,
        rows,
        toolCallCount: rows.filter((row) => row.source === 'tool').length,
      };
    })
    .filter((g) => g.rows.length > 0);
}

function oneLineTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract the latest non-empty line from streaming text for the panel title.
 * During streaming, briefs update the panel title instead of appearing in the main response.
 */
export function extractLatestBriefLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) {
      const title = oneLineTitle(line);
      return title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
    }
  }
  return '';
}


export function auxiliaryPanelTitleFromChainGroups(groups: readonly ToolChainGroup[]): string {
  for (let i = groups.length - 1; i >= 0; i--) {
    const rows = groups[i].rows;
    for (let j = rows.length - 1; j >= 0; j--) {
      const row = rows[j];
      if (!isClaraOuterBriefStreamTag(row.streamTag)) {
        continue;
      }
      const title = oneLineTitle(row.text || row.label);
      if (!title) {
        continue;
      }
      return title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
    }
  }
  return DEFAULT_AUXILIARY_STREAM_PANEL_TITLE;
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
    NgxSpinnerComponent,
    AuxiliaryStreamPanelComponent,
  ],
  templateUrl: './chat-box.html',
  styleUrl: './chat-box.css',
  encapsulation: ViewEncapsulation.None,
})
export class ChatBox implements OnDestroy {
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);
  readonly talkUi = inject(TalkUiState);

  /** Template: ordered persisted reasoning + delegated streams. */
  readonly persistedAuxiliaryStreamTimeline = persistedAuxiliaryStreamTimeline;

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
  /** While streaming, follow growing primary reply only when the user is pinned to the bottom. */
  private pinToBottom = true;
  private prevLoadingForCompletionScroll = false;
  private prevStreamPrimaryKey = '';
  private prevStreamAuxKey = '';
  private wasProcessingToolsActive = false;
  private readonly toolPhaseSynonymIndex = signal(0);
  private chatDestroyed = false;
  private convScrollTimeout: ReturnType<typeof setTimeout> | null = null;
  private chatScrollResizeObserver: ResizeObserver | null = null;
  private readonly onSendResponseDom: EventListener = ((event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    this.sendResponse.emit(typeof detail === 'string' ? detail : String(detail ?? ''));
  }) as EventListener;

  readonly messages = input<ChatMessage[]>([]);
  readonly conversationId = input<string | null>(null);
  readonly loading = input(false);
  readonly processingToolsActive = input(false);
  readonly ttsLoading = input(false);
  readonly streamingParts = input<StreamPart[]>([]);
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

  /** Row heights padded with estimates when measurement lags (keeps virtual window from rendering all rows). */
  readonly rowHeightsAligned = computed(() => {
    const rows = this.persistedRows();
    const h = this.rowHeights();
    const fs = this.fontSize();
    if (rows.length === h.length) {
      return h;
    }
    return rows.map((r, i) => (i < h.length ? h[i]! : estimateChatRowHeight(r, fs)));
  });

  /**
   * Fingerprint of the latest persisted assistant reply (length + tail) so we can re-run markdown
   * after the view commits — avoids a one-frame plain / stale pipe edge when the stream lands.
   */
  private readonly assistantMarkdownKey = computed(() => {
    const rows = this.persistedRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind === 'assistant-turn' && row.assistant?.text) {
        const t = row.assistant.text;
        return `${t.length}:${t.slice(-160)}`;
      }
    }
    return '';
  });

  /** Bumped after render when the fingerprint changes while not streaming — refreshes `markdown` pipe input. */
  readonly assistantMdLayoutPass = signal(0);

  /**
   * Windowed transcript: only `slots` are in the DOM when the conversation is long.
   * Spacers preserve scroll extent using measured or estimated row heights.
   */
  readonly virtualWindow = computed(() => {
    const rows = this.persistedRows();
    const n = rows.length;
    const h = this.rowHeightsAligned();
    const st = this.scrollTopSig();
    const vh = this.viewportHeightSig() || 480;

    if (n < CHAT_VIRTUAL_THRESHOLD) {
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

  readonly liveAuxiliaryTimeline = computed(() => multiplexAuxiliaryStreamTimeline(this.streamingParts()));

  /**
   * Raw primary stream text - used for extracting the brief to show as panel title.
   * During streaming, briefs update the panel title; the main response area stays empty.
   * Only the final response (from backend's last_final_text) appears after completion.
   */
  private readonly rawPrimaryStreamText = computed(() =>
    joinPrimaryAssistantStreamText(this.streamingParts()),
  );

  /**
   * Live primary stream text for display - returns empty during streaming.
   * Briefs are shown only as the panel title, not in the main response area.
   * The final persisted message comes from the backend's last_final_text.
   */
  readonly primaryStreamLiveText = computed(() => '');

  readonly showStreamingPrimaryCursor = computed(
    () => this.loading() && this.primaryStreamParts().some((p) => p.text.length > 0),
  );

  readonly liveTurn = computed<Extract<ChatDisplayRow, { kind: 'assistant-turn' }> | null>(() => {
    if (!this.loading()) return null;
    const rows = this.transcriptRows();
    const last = rows.at(-1);
    const trailingTurn = last?.kind === 'assistant-turn' && !last.assistant ? last : null;
    // In-flight turn (tool trail, HITL cards, stream text) always renders in the live bubble.
    return (
      trailingTurn ?? {
        kind: 'assistant-turn',
        assistant: null,
        chainGroups: [],
        artifacts: [],
      }
    );
  });

  /** True while the live bubble is blocked on diff / delete / copy / command approval. */
  readonly liveAwaitingHitlReview = computed(() => {
    const turn = this.liveTurn();
    return turn != null && turnHasPendingHitlArtifacts(turn.artifacts);
  });

  readonly liveVisibleChainGroups = computed(() => {
    const liveTurn = this.liveTurn();
    if (!liveTurn) return [];
    return filterLiveToolChainGroups(liveTurn.chainGroups);
  });

  /** Hides duplicate tool-only rows from the live strip when they stream inside the reasoning panel. */
  readonly liveChainGroupsForDisplay = computed(() => {
    let base = this.liveVisibleChainGroups();
    base = stripClaraChainRowsFromChainGroups(base);
    if (auxiliaryTimelineEmbedsToolStatus(this.liveAuxiliaryTimeline())) {
      base = stripToolChainRowsFromChainGroups(base);
    }
    return base;
  });

  /**
   * Panel title: uses the latest brief from the primary stream.
   * Every brief updates this title during streaming.
   */
  readonly liveAuxiliaryPanelTitle = computed(() => {
    const brief = extractLatestBriefLine(this.rawPrimaryStreamText());
    if (brief) {
      return brief;
    }
    const fromChainGroups = auxiliaryPanelTitleFromChainGroups(this.liveVisibleChainGroups());
    if (fromChainGroups !== DEFAULT_AUXILIARY_STREAM_PANEL_TITLE) {
      return fromChainGroups;
    }
    return DEFAULT_AUXILIARY_STREAM_PANEL_TITLE;
  });

  /**
   * Show the auxiliary panel during streaming when there's a brief or auxiliary content.
   */
  readonly showLiveAuxiliaryPanel = computed(() =>
    this.liveAuxiliaryTimeline().length > 0 || this.rawPrimaryStreamText().trim().length > 0,
  );

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
        this.chatScrollResizeObserver?.disconnect();
        this.chatScrollResizeObserver = new ResizeObserver(() => {
          this.viewportHeightSig.set(elScroll.clientHeight);
          requestAnimationFrame(() => this.updatePinFromScroll());
        });
        this.chatScrollResizeObserver.observe(elScroll);
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
            const loading = this.loading();
            if (
              !loading ||
              added.some((m) => m.role === 'user') ||
              added.some(isHitlActivationMessage)
            ) {
              this.debouncedSmoothScrollToBottom();
            }
          }
        }
        this.scrollTrackedMsgLen = msgs.length;
      });
    });

    effect(() => {
      const loading = this.loading();
      const _parts = this.streamingParts();
      untracked(() => {
        if (!loading) {
          return;
        }
        const primary = this.primaryStreamLiveText();
        const auxParts = this.liveAuxiliaryTimeline();
        const primaryKey =
          primary.length === 0 ? '' : `${primary.length}:${primary.slice(-120)}`;
        const auxKey = auxParts
          .map((p) => `${String(p.streamTag ?? '')}:${String(p.label ?? '')}:${p.text.length}`)
          .join('\u001f');

        const primaryChanged = primaryKey !== this.prevStreamPrimaryKey;
        const auxChanged = auxKey !== this.prevStreamAuxKey;
        if (primaryChanged) {
          this.prevStreamPrimaryKey = primaryKey;
        }
        if (auxChanged) {
          this.prevStreamAuxKey = auxKey;
        }
        if (!primaryChanged && auxChanged) {
          return;
        }
        if (primaryChanged && this.pinToBottom) {
          this.scrollToBottom('instant');
        }
      });
    });

    effect(() => {
      const loading = this.loading();
      untracked(() => {
        if (loading && !this.prevLoadingForCompletionScroll) {
          this.prevStreamPrimaryKey = '';
          this.prevStreamAuxKey = '';
        }
        if (this.prevLoadingForCompletionScroll && !loading) {
          afterNextRender(
            () => {
              if (this.chatDestroyed) {
                return;
              }
              this.scrollToBottom('smooth');
            },
            { injector: this.inj },
          );
        }
        this.prevLoadingForCompletionScroll = loading;
      });
    });

    effect(() => {
      this.virtualWindow();
      untracked(() => this.scheduleMeasureVisibleRows());
    });

    effect(() => {
      this.el.nativeElement.style.setProperty('--chat-font-size', `${this.fontSize()}rem`);
    });

    effect(() => {
      if (this.loading()) {
        return;
      }
      const key = this.assistantMarkdownKey();
      if (!key) {
        return;
      }
      untracked(() => {
        afterNextRender(
          () => {
            this.assistantMdLayoutPass.update((n) => n + 1);
          },
          { injector: this.inj },
        );
      });
    });

    this.el.nativeElement.addEventListener('send-response', this.onSendResponseDom);

    effect(() => {
      const loading = this.loading();
      const tools = this.processingToolsActive();
      const awaitingHitl = this.liveAwaitingHitlReview();
      untracked(() => {
        if (loading && tools && !this.wasProcessingToolsActive) {
          const chainN = this.messages().filter((m) => m.role === 'chain').length;
          const key = `${this.conversationId() ?? ''}:${chainN}`;
          this.toolPhaseSynonymIndex.set(hashToUint(key) % TOOL_BUILDING_SYNONYMS.length);
        }
        this.wasProcessingToolsActive = tools;
        if (!loading || awaitingHitl) {
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
    this.el.nativeElement.removeEventListener('send-response', this.onSendResponseDom);
    this.chatScrollResizeObserver?.disconnect();
    this.chatScrollResizeObserver = null;
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
      this.updatePinFromScroll();
      this.scheduleMeasureVisibleRows();
    });
  }

  private updatePinFromScroll(): void {
    const box = this.chatScroll()?.nativeElement;
    if (!box) return;
    const slack = box.scrollHeight - box.scrollTop - box.clientHeight;
    this.pinToBottom = slack <= SCROLL_BOTTOM_PIN_THRESHOLD_PX;
  }

  isLastPersistedRow(index: number): boolean {
    return index === this.persistedRows().length - 1;
  }

  /** Stable keys for `\@for` over artifacts (avoid `$index` reuse bugs). */
  protected artifactTrackKey(artifact: ArtifactMessage): string {
    switch (artifact.role) {
      case 'diff': {
        const p = artifact.payload;
        return `diff:${p.relativePath}|${p.baseSha256 ?? ''}|${p.rows.length}|${p.fullNewContent.length}`;
      }
      case 'accept_command':
        return `accept:${artifact.payload.requestId}`;
      case 'copy_confirm':
        return `copy:${artifact.payload.requestId}`;
      case 'delete_confirm':
        return `del:${artifact.payload.requestId}`;
      default:
        return 'artifact';
    }
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
      this.updatePinFromScroll();
    });
  }

  /**
   * When this turn’s auxiliary timeline includes embedded tool-status segments, omit duplicate
   * `source: tool` rows from the collapsible strip above it.
   */
  chainGroupsForPersistedTurn(row: ChatDisplayRow): ToolChainGroup[] {
    if (row.kind !== 'assistant-turn') {
      return [];
    }
    let groups = row.chainGroups;
    const timeline = persistedAuxiliaryStreamTimeline(row.assistant ?? undefined);
    if (auxiliaryTimelineEmbedsToolStatus(timeline)) {
      groups = stripToolChainRowsFromChainGroups(groups);
    }
    groups = stripClaraChainRowsFromChainGroups(groups);
    return groups;
  }

  auxiliaryPanelTitleForTurn(_row: ChatDisplayRow): string {
    return PERSISTED_AUXILIARY_STREAM_PANEL_TITLE;
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
