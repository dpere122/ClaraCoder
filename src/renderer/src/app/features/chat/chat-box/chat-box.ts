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
import type { StreamPart, PlannerProgress } from '@shared/index';
import {
  isClaraOuterBriefStreamTag,
  joinPrimaryAssistantStreamText,
  multiplexAuxiliaryStreamTimeline,
  persistedAuxiliaryStreamTimeline,
  primaryStreamPartsForDisplay,
} from '@shared/index';
import { MarkdownPipe } from './markdown.pipe';
import {
  AuxiliaryStreamPanelComponent,
  DEFAULT_AUXILIARY_STREAM_PANEL_TITLE,
  PERSISTED_AUXILIARY_STREAM_PANEL_TITLE,
} from './auxiliary-stream-panel/auxiliary-stream-panel';
import { PlannerChecklistComponent } from './planner-checklist/planner-checklist';
import { HitlTrailPanelComponent } from './hitl-trail-panel/hitl-trail-panel';
import { ToolChainPillComponent } from './tool-chain-pill/tool-chain-pill';
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
import {
  auxiliaryPanelTitleFromChainGroups,
  buildChatDisplayRows,
  extractLatestBriefLine,
  filterLiveToolChainGroups,
  hashChatToolPhaseKey,
  hitlArtifactsExcludingPlanConfirm,
  isHitlActivationMessage,
  isScrollWorthyAppendMessage,
  planPanelContext,
  resolveLiveAssistantTurn,
  stripClaraChainRowsFromChainGroups,
  stripPlannerChainRowsFromChainGroups,
  stripToolChainRowsFromChainGroups,
  shouldStripToolChainRowsForAuxPanel,
  liveTurnPresentationSettled as computeLiveTurnPresentationSettled,
  turnHasPlanPanel,
  toolChainSummary,
  TOOL_BUILDING_SYNONYMS,
  turnHasPendingHitlArtifacts,
  type ArtifactMessage,
  type ChatDisplayRow,
  type ChatMessage,
  type ToolChainGroup,
} from './chat-box-display';

export {
  auxiliaryPanelTitleFromChainGroups,
  buildChatDisplayRows,
  extractLatestBriefLine,
  filterLiveToolChainGroups,
  hitlArtifactsExcludingPlanConfirm,
  isHitlActivationMessage,
  isPendingHitlArtifact,
  isScrollWorthyAppendMessage,
  planPanelContext,
  stripPlannerChainRowsFromChainGroups,
  shouldStripToolChainRowsForAuxPanel,
  liveTurnPresentationSettled,
  turnHasPlanPanel,
  TOOL_BUILDING_SYNONYMS,
  turnHasPendingHitlArtifacts,
  type ArtifactMessage,
  type ChatDisplayRow,
  type ChatMessage,
  type ToolChainGroup,
} from './chat-box-display';

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

type ChainMessage = Extract<ChatMessage, { role: 'chain' }>;

@Component({
  selector: 'app-chat-box',
  imports: [
    MarkdownPipe,
    RunButtonDirective,
    NgxSpinnerComponent,
    AuxiliaryStreamPanelComponent,
    HitlTrailPanelComponent,
    PlannerChecklistComponent,
    ToolChainPillComponent,
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
  readonly streamingPlanner = input<PlannerProgress | null>(null);
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
  readonly planConfirmFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly stagedTransferBatchFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
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

  readonly liveTurnPresentationSettled = computed(() =>
    computeLiveTurnPresentationSettled(
      !!this.livePlanPanel(),
      this.rawPrimaryStreamText(),
      this.primaryStreamLiveText(),
    ),
  );

  readonly liveChainToolLive = computed(() => this.loading() && !this.liveTurnPresentationSettled());

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
    return (
      resolveLiveAssistantTurn(this.transcriptRows()) ?? {
        kind: 'assistant-turn',
        assistant: null,
        chainGroups: [],
        artifacts: [],
      }
    );
  });

  readonly livePlanPanel = computed(() => {
    if (!this.loading()) return null;
    return planPanelContext(this.streamingPlanner(), this.liveTurn()?.artifacts ?? []);
  });

  readonly liveHitlArtifacts = computed(() => {
    const turn = this.liveTurn();
    if (!turn) return [];
    return hitlArtifactsExcludingPlanConfirm(turn.artifacts);
  });

  /** True while the live bubble is blocked on diff / delete / copy / command / plan approval. */
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
    if (this.livePlanPanel()) {
      base = stripPlannerChainRowsFromChainGroups(base);
    }
    if (shouldStripToolChainRowsForAuxPanel(this.liveAuxiliaryTimeline(), !!this.livePlanPanel())) {
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
   * When the unified plan panel is visible, omit a title-only shell (no multiplex segments).
   */
  readonly showLiveAuxiliaryPanel = computed(() => {
    if (this.liveAuxiliaryTimeline().length > 0) {
      return true;
    }
    if (this.livePlanPanel()) {
      return false;
    }
    return this.rawPrimaryStreamText().trim().length > 0;
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
          this.toolPhaseSynonymIndex.set(hashChatToolPhaseKey(key) % TOOL_BUILDING_SYNONYMS.length);
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
    const hasPlan = turnHasPlanPanel(row.assistant?.planner, row.artifacts);
    if (shouldStripToolChainRowsForAuxPanel(timeline, hasPlan)) {
      groups = stripToolChainRowsFromChainGroups(groups);
    }
    groups = stripClaraChainRowsFromChainGroups(groups);
    if (hasPlan) {
      groups = stripPlannerChainRowsFromChainGroups(groups);
    }
    return groups;
  }

  planPanelForTurn(row: ChatDisplayRow): ReturnType<typeof planPanelContext> {
    if (row.kind !== 'assistant-turn') return null;
    return planPanelContext(row.assistant?.planner, row.artifacts);
  }

  hitlArtifactsForTurn(row: ChatDisplayRow): ArtifactMessage[] {
    if (row.kind !== 'assistant-turn') return [];
    return hitlArtifactsExcludingPlanConfirm(row.artifacts);
  }

  auxiliaryPanelTitleForTurn(_row: ChatDisplayRow): string {
    return PERSISTED_AUXILIARY_STREAM_PANEL_TITLE;
  }


  readonly toolChainSummary = toolChainSummary;
}
