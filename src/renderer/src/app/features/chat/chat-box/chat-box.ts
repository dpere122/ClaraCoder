/**
 * Scrollable chat transcript: persisted turns, live streaming bubble, virtualized long history,
 * auto-scroll policy, and inline spinners (thinking / tools / TTS).
 *
 * **Data flow**
 * - Parent passes raw {@link ChatMessage}[] plus live SSE fields (`streamingParts`, `streamingFinalText`, …).
 * - {@link buildChatDisplayRows} (in `chat-box-display.ts`) groups chain + artifact rows into assistant turns.
 * - Persisted rows render from `persistedRows`; the in-flight turn renders separately via `liveTurn` while `loading`.
 *
 * **Presentation**
 * - One chronological feed: thought pills, tool pills, and rendered markdown (`buildTurnFeed`).
 * - Backend `final_text` replaces in-feed `agent` segments with the clean reply.
 * - HITL change rows merge into the feed; interactive reviews live in the composer dock.
 *
 * Display helpers and types are re-exported below for parent components and tests.
 */
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
import type { PlannerProgress, StreamPart } from '@shared/index';
import { canRestoreToUserMessage } from '@shared/index';
import {
  buildTurnFeed,
  joinPrimaryAssistantStreamText,
  mergeHitlTrailIntoAuxiliaryTimeline,
  persistedAuxiliaryStreamTimeline,
  turnFeedScrollKey,
  type TurnFeedItem,
} from '@shared/index';
import { PlannerChecklistComponent } from './planner-checklist/planner-checklist';
import { RunButtonDirective } from './run-button.directive';
import { StreamTurnFeedComponent } from './stream-turn-feed/stream-turn-feed';
import {
  CHAT_MIN_FALLBACK_ROW,
  CHAT_VIRTUAL_PIXEL_BUFFER,
  CHAT_VIRTUAL_THRESHOLD,
  computeVirtualRange,
  estimateChatRowHeight,
  sumHeights,
} from './chat-box-virtual';
import {
  buildChatDisplayRows,
  decideInstantScrollOnStreamingUpdate,
  hashChatToolPhaseKey,
  hitlArtifactsExcludingPlanConfirm,
  isHitlActivationMessage,
  isScrollWorthyAppendMessage,
  planPanelContext,
  resolveLiveAssistantTurn,
  resolvePrimaryStreamLiveText,
  liveTurnPresentationSettled as computeLiveTurnPresentationSettled,
  TOOL_BUILDING_SYNONYMS,
  turnHasPendingHitlArtifacts,
  userMessageAttachedFiles,
  userMessageImageUrls,
  type ChatDisplayRow,
  type ChatMessage,
} from './chat-box-display';

export {
  auxiliaryPanelTitleFromChainGroups,
  buildChatDisplayRows,
  decideInstantScrollOnStreamingUpdate,
  extractLatestBriefLine,
  filterLiveToolChainGroups,
  hitlArtifactsExcludingPlanConfirm,
  isHitlActivationMessage,
  isPendingHitlArtifact,
  isScrollWorthyAppendMessage,
  pendingHitlArtifactsForDock,
  planPanelContext,
  resolveLiveAssistantTurn,
  resolvePrimaryStreamLiveText,
  liveTurnPresentationSettled,
  turnHasPlanPanel,
  TOOL_BUILDING_SYNONYMS,
  turnHasPendingHitlArtifacts,
  userMessageAttachedFiles,
  userMessageImageUrls,
  type ArtifactMessage,
  type ChatDisplayRow,
  type ChatMessage,
  type ToolChainGroup,
} from './chat-box-display';

export type ChatLayoutMode = 'sidebar' | 'expanded';

/** Pixels from the bottom of the chat viewport to treat as “pinned” for follow-final-message behavior. */
const SCROLL_BOTTOM_PIN_THRESHOLD_PX = 48;

/** ngx-spinner names scoped to this component (hidden in `ngOnDestroy`). */
const SPINNER_CHAT_THINK = 'chat-think';
const SPINNER_CHAT_TTS = 'chat-tts';

const INLINE_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--bs-secondary-color)',
};

@Component({
  selector: 'app-chat-box',
  imports: [
    RunButtonDirective,
    NgxSpinnerComponent,
    PlannerChecklistComponent,
    StreamTurnFeedComponent,
  ],
  templateUrl: './chat-box.html',
  styleUrl: './chat-box.css',
  encapsulation: ViewEncapsulation.None,
  host: {
    '[class.chat-layout-sidebar]': 'layout() === "sidebar"',
  },
})
/**
 * Renders the conversation transcript inside the chat pane.
 *
 * Owns scroll/virtualization and live-stream presentation; does not fetch data.
 * Parent supplies messages and stream signals; child panels emit HITL results upward.
 */
export class ChatBox implements OnDestroy {
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);

  /** Template helpers: attachments rendered above a user bubble's text. */
  readonly userImageUrls = userMessageImageUrls;
  readonly userAttachedFiles = userMessageAttachedFiles;

  canRestoreUserRow(msg: Extract<ChatMessage, { role: 'user' }>): boolean {
    const messages = this.messages();
    const idx = messages.indexOf(msg);
    return canRestoreToUserMessage(messages, idx, { streaming: this.loading() });
  }

  onRestoreUserRow(msg: Extract<ChatMessage, { role: 'user' }>, event?: Event): void {
    event?.stopPropagation();
    const userMessageIndex = this.messages().indexOf(msg);
    if (userMessageIndex < 0) {
      return;
    }
    this.restoreConversation.emit({ userMessageId: msg.id, userMessageIndex });
  }

  /** Scrollport element (`#chatScroll` in template); drives virtual window + pin detection. */
  readonly chatScroll = viewChild<ElementRef<HTMLElement>>('chatScroll');

  // --- Virtual scroll state (see `chat-box-virtual.ts`) ---

  /** Measured or estimated height per persisted row (index-aligned with `persistedRows`). */
  private readonly rowHeights = signal<number[]>([]);
  /** Latest scrollTop of `#chatScroll` (feeds `virtualWindow`). */
  private readonly scrollTopSig = signal(0);
  /** Client height of `#chatScroll` (updated on scroll + ResizeObserver). */
  private readonly viewportHeightSig = signal(0);
  /** Last conversation id seen by the row-height reset effect. */
  private lastConversationId: string | null = null;

  // --- Scroll scheduling / auto-follow ---

  private scrollRaf = 0;
  private measurePassScheduled = false;
  private scrollToBottomRaf = 0;
  /** Transcript length at last scroll decision (per conversation). */
  private scrollTrackedMsgLen = 0;
  private scrollTrackedConvId: string | null | undefined = undefined;
  private scrollSmoothDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** While streaming, follow growing primary reply only when the user is pinned to the bottom. */
  private pinToBottom = true;
  private prevLoadingForCompletionScroll = false;
  /** Fingerprint tail for streaming scroll dedupe (unified turn feed). */
  private prevStreamFeedKey = '';
  /** Tracks live plan checklist mount so discovery/planning chrome can autoscroll. */
  private prevLivePlanPanelVisible = false;
  private wasProcessingToolsActive = false;
  /** Stable synonym pick for the “tool building” processing label. */
  private readonly toolPhaseSynonymIndex = signal(0);
  private chatDestroyed = false;
  private convScrollTimeout: ReturnType<typeof setTimeout> | null = null;
  private chatScrollResizeObserver: ResizeObserver | null = null;

  /** Bridges `send-response` DOM events from nested HITL / run-button UI to `sendResponse` output. */
  private readonly onSendResponseDom: EventListener = ((event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    this.sendResponse.emit(typeof detail === 'string' ? detail : String(detail ?? ''));
  }) as EventListener;

  // --- Inputs (parent owns transcript + stream SSE) ---

  /** Full conversation transcript (user, assistant, chain, artifact messages). */
  readonly messages = input<ChatMessage[]>([]);
  /** Active conversation; changes reset virtual heights and scroll tracking. */
  readonly conversationId = input<string | null>(null);
  /** True while an assistant reply is in flight (shows live bubble + spinners). */
  readonly loading = input(false);
  /** True during tool execution phase of a turn (swaps think spinner for tool spinner + label). */
  readonly processingToolsActive = input(false);
  /** True while TTS audio for the latest reply is loading. */
  readonly ttsLoading = input(false);
  /** Multiplexed SSE stream parts (reasoning, tools, planner, primary chunks). */
  readonly streamingParts = input<StreamPart[]>([]);
  /** Clean final reply from backend (`final_text` SSE), available before `[DONE]`. */
  readonly streamingFinalText = input<string | undefined>(undefined);
  /** Live planner progress when plan-and-execute mode is active. */
  readonly streamingPlanner = input<PlannerProgress | null>(null);
  /** Root `--chat-font-size` multiplier (rem). */
  readonly fontSize = input(0.9);
  /** Sidebar hub vs main-panel expanded overlay (reserved for layout-specific chrome). */
  readonly layout = input<ChatLayoutMode>('expanded');

  // --- Outputs (HITL completion + composer send) ---

  /** User submitted a follow-up from an embedded prompt (via `send-response` DOM event). */
  readonly restoreConversation = output<{ userMessageId?: string; userMessageIndex: number }>();
  readonly sendResponse = output<string>();
  /** Diff review card completed or dismissed. */
  readonly diffReviewFinished = output<{
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  /** Delete confirmation card completed or dismissed. */
  readonly deleteReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  /** Shell command approval card completed or dismissed. */
  readonly acceptCommandFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  /** Copy-to-workspace confirmation completed or dismissed. */
  readonly copyReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  /** Plan-and-execute approval completed or dismissed. */
  readonly planConfirmFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  /** Plan-mode clarifying-questions card submitted or cancelled. */
  readonly agentQuestionFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  /** Staged file transfer batch reviewed (per-file resolution map). */
  readonly stagedTransferBatchFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
  }>();
  /** Mid-batch file resolution persisted before batch completes. */
  readonly stagedTransferBatchFileResolved = output<{
    requestId: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
  }>();

  // --- Transcript projection ---

  /** All display rows including the in-flight assistant shell while `loading`. */
  readonly transcriptRows = computed(() => buildChatDisplayRows(this.messages()));

  /**
   * Rows committed to the virtualized list. While streaming, drops the trailing empty
   * assistant-turn shell so the live bubble (below the list) is the single source of truth.
   */
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

  /** Chronological live feed: thought pills, tool pills, and markdown. */
  readonly liveTurnFeed = computed(() =>
    buildTurnFeed(
      mergeHitlTrailIntoAuxiliaryTimeline(this.streamingParts(), this.liveHitlArtifacts()),
      this.streamingFinalText(),
    ),
  );

  /** Persisted turn feed (timeline + final assistant markdown). */
  turnFeedForRow(row: Extract<ChatDisplayRow, { kind: 'assistant-turn' }>): TurnFeedItem[] {
    return buildTurnFeed(
      mergeHitlTrailIntoAuxiliaryTimeline(
        persistedAuxiliaryStreamTimeline(row.assistant),
        hitlArtifactsExcludingPlanConfirm(row.artifacts),
      ),
      row.assistant?.text,
    );
  }

  /** True once plan UI or final primary text makes the live turn look “settled” (hides tool-live chrome). */
  readonly liveTurnPresentationSettled = computed(() =>
    computeLiveTurnPresentationSettled(
      !!this.livePlanPanel(),
      joinPrimaryAssistantStreamText(this.streamingParts()),
      this.primaryStreamLiveText(),
    ),
  );

  /**
   * Live primary stream text — latest `agent` segment while the model is writing; backend
   * `final_text` replaces it once the clean reply is available.
   */
  readonly primaryStreamLiveText = computed(() =>
    resolvePrimaryStreamLiveText(
      this.streamingFinalText(),
      this.streamingParts(),
      this.processingToolsActive(),
    ),
  );

  /** Blinking cursor while the main reply is still streaming (hidden once `final_text` lands). */
  readonly showStreamingPrimaryCursor = computed(
    () =>
      this.loading() &&
      !(this.streamingFinalText() ?? '').trim() &&
      this.liveTurnFeed().some((item) => item.kind === 'markdown'),
  );

  /**
   * In-flight assistant turn: chain groups + artifacts from the open transcript tail,
   * or an empty shell when streaming started before any chain rows landed.
   */
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

  /** Planner checklist + optional plan-confirm HITL for the live bubble. */
  readonly livePlanPanel = computed(() => {
    if (!this.loading()) return null;
    return planPanelContext(this.streamingPlanner(), this.liveTurn()?.artifacts ?? []);
  });

  /** Trail HITL artifacts for the live turn (plan/question excluded — composer dock + plan progress). */
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

  /** Short status word beside the think/tool spinner in the live processing row. */
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
    // Observe scrollport size so virtual window math stays correct when the pane is resized.
    // When the viewport shrinks while pinned to the bottom (HITL dock slides up or the
    // terminal auto-expands below, covering the chat), re-bottom so the latest content
    // stays visible instead of getting hidden under the newly revealed chrome.
    afterNextRender(
      () => {
        const elScroll = this.chatScroll()?.nativeElement;
        if (!elScroll) return;
        this.viewportHeightSig.set(elScroll.clientHeight);
        this.chatScrollResizeObserver?.disconnect();
        this.chatScrollResizeObserver = new ResizeObserver(() => {
          const prevHeight = this.viewportHeightSig();
          const wasPinned = this.pinToBottom;
          const nextHeight = elScroll.clientHeight;
          this.viewportHeightSig.set(nextHeight);
          if (nextHeight < prevHeight && wasPinned) {
            this.scrollToBottom('instant');
          } else {
            requestAnimationFrame(() => this.updatePinFromScroll());
          }
        });
        this.chatScrollResizeObserver.observe(elScroll);
      },
      { injector: this.inj },
    );

    // Reset or extend row height estimates when conversation changes or rows are appended.
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

    // Auto-scroll: jump on conversation switch; smooth-scroll on user/HITL appends worth following.
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

    // During streaming: follow unified feed growth while pinned to the bottom.
    effect(() => {
      const loading = this.loading();
      const feedKey = turnFeedScrollKey(this.liveTurnFeed());
      untracked(() => {
        if (!loading) {
          return;
        }
        const decision = decideInstantScrollOnStreamingUpdate(
          {
            primaryKey: feedKey,
            auxKey: '',
            auxPanelVisible: false,
          },
          {
            prevPrimaryKey: this.prevStreamFeedKey,
            prevAuxKey: '',
            prevAuxPanelVisible: false,
          },
        );
        this.prevStreamFeedKey = decision.next.prevPrimaryKey;

        if (!this.pinToBottom) {
          return;
        }
        if (decision.scrollNow) {
          this.scrollToBottom('instant');
        }
      });
    });

    // Plan mode: autoscroll when the live plan checklist first takes layout height.
    effect(() => {
      const loading = this.loading();
      const planVisible = !!this.livePlanPanel();
      untracked(() => {
        if (!loading) {
          this.prevLivePlanPanelVisible = false;
          return;
        }
        const becameVisible = planVisible && !this.prevLivePlanPanelVisible;
        this.prevLivePlanPanelVisible = planVisible;
        if (!becameVisible || !this.pinToBottom) {
          return;
        }
        afterNextRender(
          () => {
            if (this.chatDestroyed || !this.pinToBottom) {
              return;
            }
            this.scrollToBottom('instant');
          },
          { injector: this.inj },
        );
      });
    });

    // One smooth scroll when a turn finishes loading (stream → persisted).
    effect(() => {
      const loading = this.loading();
      untracked(() => {
        if (loading && !this.prevLoadingForCompletionScroll) {
          this.prevLivePlanPanelVisible = false;
          this.prevStreamFeedKey = '';
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

    // Re-measure visible `[data-chat-row]` nodes whenever the virtual window moves.
    effect(() => {
      this.virtualWindow();
      untracked(() => this.scheduleMeasureVisibleRows());
    });

    effect(() => {
      this.el.nativeElement.style.setProperty('--chat-font-size', `${this.fontSize()}rem`);
    });

    // After stream ends, bump layout pass so markdown pipe re-runs on the final assistant body.
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

    // Think vs tool spinner in the live row; suppressed while HITL blocks the turn.
    effect(() => {
      const loading = this.loading();
      const tools = this.processingToolsActive();
      const awaitingHitl = this.liveAwaitingHitlReview();
      // Re-run when the live-turn host (ngx-spinner targets) mounts — e.g. sidebar → expanded swap mid-stream.
      this.liveTurn();
      this.liveTurnFeed();
      untracked(() => {
        if (loading && tools && !this.wasProcessingToolsActive) {
          const chainN = this.messages().filter((m) => m.role === 'chain').length;
          const key = `${this.conversationId() ?? ''}:${chainN}`;
          this.toolPhaseSynonymIndex.set(hashChatToolPhaseKey(key) % TOOL_BUILDING_SYNONYMS.length);
        }
        this.wasProcessingToolsActive = tools;
        this.scheduleProcessingSpinnerSync();
      });
    });

    // TTS loading spinner beside playback controls.
    effect(() => {
      this.ttsLoading();
      untracked(() => this.scheduleTtsSpinnerSync());
    });

  }

  /**
   * ngx-spinner registers named hosts on child init. Defer show/hide until after render so a
   * freshly mounted chat box (sidebar ↔ expanded) still picks up an in-flight `loading` turn.
   */
  private scheduleProcessingSpinnerSync(): void {
    afterNextRender(
      () => {
        if (this.chatDestroyed) {
          return;
        }
        const loading = this.loading();
        const awaitingHitl = this.liveAwaitingHitlReview();
        const feedEmpty = this.liveTurnFeed().length === 0;
        if (!loading || awaitingHitl || !feedEmpty) {
          void this.ngxSpinner.hide(SPINNER_CHAT_THINK);
          return;
        }
        void this.ngxSpinner.show(SPINNER_CHAT_THINK, { ...INLINE_SPINNER, type: 'ball-atom' });
      },
      { injector: this.inj },
    );
  }

  private scheduleTtsSpinnerSync(): void {
    afterNextRender(
      () => {
        if (this.chatDestroyed) {
          return;
        }
        if (this.ttsLoading()) {
          void this.ngxSpinner.show(SPINNER_CHAT_TTS, { ...INLINE_SPINNER, type: 'line-scale' });
        } else {
          void this.ngxSpinner.hide(SPINNER_CHAT_TTS);
        }
      },
      { injector: this.inj },
    );
  }

  /** Tear down observers, timers, DOM listeners, and ngx-spinner instances. */
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
    void this.ngxSpinner.hide(SPINNER_CHAT_THINK);
    void this.ngxSpinner.hide(SPINNER_CHAT_TTS);
  }

  /** Template `(scroll)` handler: coalesced updates to virtual window + pin state. */
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

  /** Sets `pinToBottom` when the viewport is within {@link SCROLL_BOTTOM_PIN_THRESHOLD_PX} of the end. */
  private updatePinFromScroll(): void {
    const box = this.chatScroll()?.nativeElement;
    if (!box) return;
    const slack = box.scrollHeight - box.scrollTop - box.clientHeight;
    this.pinToBottom = slack <= SCROLL_BOTTOM_PIN_THRESHOLD_PX;
  }

  /** Template helper: last row in the virtualized persisted list (e.g. markdown layout pass). */
  isLastPersistedRow(index: number): boolean {
    return index === this.persistedRows().length - 1;
  }

  /** Reads `[data-chat-row]` heights after render and patches `rowHeights` for virtual math. */
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

  /** Batches rapid message appends into one smooth scroll (80 ms). */
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

  /** Scroll `#chatScroll` (or `.chat-box` fallback) to `scrollHeight` and refresh measurements. */
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

  /** Persisted-turn planner panel context (mirrors `livePlanPanel` for saved turns). */
  planPanelForTurn(row: ChatDisplayRow): ReturnType<typeof planPanelContext> {
    if (row.kind !== 'assistant-turn') return null;
    return planPanelContext(row.assistant?.planner, row.artifacts);
  }
}
