/**
 * Scrollable chat transcript: persisted turns, live streaming bubble, virtualized long history,
 * auto-scroll policy, and inline spinners (prefill / thinking / read tools / write tools / TTS).
 *
 * **Data flow**
 * - Parent passes raw {@link ChatMessage}[] plus live SSE fields (`streamingParts`, `streamingFinalText`, …).
 * - {@link buildChatDisplayRows} (in `chat-box-display.ts`) groups chain + artifact rows into assistant turns.
 * - Persisted rows render from `persistedRows`; the in-flight turn renders separately via `liveTurn` while `loading`.
 *
 * **Presentation**
 * - One chronological feed: thought pills, nudge pills, tool pills, and rendered markdown (`buildTurnFeed`).
 * - Clara briefs (planning prose before / between tool calls) render as markdown in place.
 * - Backend `final_text` replaces the trailing `agent` reply segment with the clean reply.
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
import { LucideAngularModule } from 'lucide-angular';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { ChatThinkingDisplay, PlannerProgress, StreamPart } from '@shared/index';
import { canRestoreToUserMessage, DEFAULT_CHAT_THINKING_DISPLAY } from '@shared/index';
import {
  buildTurnFeed,
  joinPrimaryAssistantStreamText,
  mergeHitlTrailIntoAuxiliaryTimeline,
  persistedAuxiliaryStreamTimeline,
  turnFeedScrollKey,
  type TurnFeedItem,
} from '@shared/index';
import { ClaraBadgeComponent } from './clara-badge/clara-badge';
import { PlannerChecklistComponent } from './planner-checklist/planner-checklist';
import { RunButtonDirective } from './run-button.directive';
import { StreamTurnFeedComponent } from './stream-turn-feed/stream-turn-feed';
import { ToolSpinnerComponent } from './tool-spinner/tool-spinner';
import { TurnEditsFooterComponent, type TurnDiffOpenRequest } from './turn-edits-footer/turn-edits-footer';
import type { HostedSpinnerKind } from './stream-turn-feed/stream-turn-feed';
import { LiveTurnActivityService } from './live-turn-activity';
import { turnGenerationSummary } from './generation-rate';
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
  chatBottomBufferPx,
  chatTurnUserContexts,
  decideChatScrollOnAppend,
  decideInstantScrollOnStreamingUpdate,
  decideStickAfterUserScroll,
  hashChatToolPhaseKey,
  hitlArtifactsExcludingPlanConfirm,
  isChatTranscriptScrollable,
  isLiveReplyStreaming,
  isProseLatestLiveFeedEvent,
  inFlightToolSpinnerKind,
  isStickFromSlack,
  isUserScrollUp,
  planPanelContext,
  scrollSlackPx,
  didFinalResponseAppear,
  shouldFollowFinalResponse,
  shouldFollowStreamComplete,
  shouldFollowStreamToken,
  shouldShowJumpToBottom,
  stickThresholdPx as computeStickThresholdPx,
  resolveLiveAssistantTurn,
  resolvePrimaryStreamLiveText,
  resolveTurnActivity,
  turnActivitySpinnerKind,
  liveTurnPresentationSettled as computeLiveTurnPresentationSettled,
  mergeClaraBriefsFromChainIntoTimeline,
  PREFILL_STYLES,
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
  CHAT_BOTTOM_BUFFER_RATIO,
  chatBottomBufferPx,
  decideChatScrollOnAppend,
  decideInstantScrollOnStreamingUpdate,
  decideStickAfterUserScroll,
  extractLatestBriefLine,
  filterLiveToolChainGroups,
  hitlArtifactsExcludingPlanConfirm,
  isChatTranscriptScrollable,
  isHitlActivationMessage,
  isLiveReplyStreaming,
  isPendingHitlArtifact,
  isProseLatestLiveFeedEvent,
  inFlightToolSpinnerKind,
  isScrollWorthyAppendMessage,
  isStickFromSlack,
  isUserScrollUp,
  SCROLL_BOTTOM_PIN_THRESHOLD_PX,
  scrollSlackPx,
  didFinalResponseAppear,
  shouldFollowFinalResponse,
  shouldFollowStreamComplete,
  shouldFollowStreamToken,
  shouldShowJumpToBottom,
  stickThresholdPx,
  hitlDockArtifactsBesidePlan,
  livePlanDockContext,
  pendingHitlArtifactsForDock,
  planPanelContext,
  resolveLiveAssistantTurn,
  resolvePrimaryStreamLiveText,
  resolveTurnActivity,
  turnActivitySpinnerKind,
  liveTurnPresentationSettled,
  mergeClaraBriefsFromChainIntoTimeline,
  turnHasPlanPanel,
  TOOL_BUILDING_SYNONYMS,
  turnHasPendingHitlArtifacts,
  userMessageAttachedFiles,
  userMessageImageUrls,
  type ArtifactMessage,
  type ChatDisplayRow,
  type ChatMessage,
  type ToolChainGroup,
  type TurnActivity,
} from './chat-box-display';
import type { AcceptCommandFinishedEvent, TurnEndedEarly } from '@shared/index';

export type ChatLayoutMode = 'sidebar' | 'expanded';

/** Footer chip text for replies that ended before the agent finished them. */
const END_EARLY_LABELS: Readonly<Record<TurnEndedEarly, string>> = {
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  error: 'Did not finish',
};

const END_EARLY_TITLES: Readonly<Record<TurnEndedEarly, string>> = {
  stopped: 'You stopped this reply; it shows what was done until then.',
  interrupted: 'You sent a new message before this reply finished; it shows what was done until then.',
  error: 'This reply failed before it finished; it shows what was done until then.',
};

/** ngx-spinner names scoped to this component (hidden in `ngOnDestroy`). */
const SPINNER_CHAT_TTS = 'chat-tts';

const INLINE_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--bs-secondary-color)',
};

const THINKING_PROCESSING_LABEL = 'thinking';

@Component({
  selector: 'app-chat-box',
  imports: [
    ClaraBadgeComponent,
    LucideAngularModule,
    RunButtonDirective,
    NgxSpinnerComponent,
    PlannerChecklistComponent,
    StreamTurnFeedComponent,
    ToolSpinnerComponent,
    TurnEditsFooterComponent,
  ],
  templateUrl: './chat-box.html',
  styleUrl: './chat-box.css',
  encapsulation: ViewEncapsulation.None,
  host: {
    '[class.chat-layout-sidebar]': 'layout() === "sidebar"',
    'data-theme-group': 'chat.transcript',
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
  private readonly shownActivityReporter = inject(LiveTurnActivityService);

  /** Template helpers: attachments rendered above a user bubble's text. */
  readonly userImageUrls = userMessageImageUrls;
  readonly userAttachedFiles = userMessageAttachedFiles;
  /** Template helper: tok/s footer under a finished reply. */
  readonly generationSummary = turnGenerationSummary;

  /** Footer chip for a reply that ended before the agent finished it. */
  endedEarlyLabel(endedEarly: TurnEndedEarly): string {
    return END_EARLY_LABELS[endedEarly];
  }

  endedEarlyTitle(endedEarly: TurnEndedEarly): string {
    return END_EARLY_TITLES[endedEarly];
  }

  canRestoreUserRow(msg: Extract<ChatMessage, { role: 'user' }>): boolean {
    if (this.readOnly()) {
      return false;
    }
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

  /** Scrollport element (`#chatScroll` in template); drives virtual window + stick/roam detection. */
  readonly chatScroll = viewChild<ElementRef<HTMLElement>>('chatScroll');
  /** Latest `spinnerKindChange` from the live feed (`null` = spinner stays in the processing row). */
  readonly liveFeedSpinnerKind = signal<HostedSpinnerKind | null>(null);

  /**
   * True while the live feed's open preview (thought header / running tool pill) hosts the turn
   * spinner — the processing row below then stays hidden so the spinner is not shown twice.
   * Gated on the feed being mounted so a stale value from a finished turn cannot leak through.
   */
  readonly liveFeedHostsSpinner = computed(
    () => this.loading() && this.liveTurnFeed().length > 0 && this.liveFeedSpinnerKind() != null,
  );

  /**
   * True while the reply or a Clara brief is being generated: primary prose is present in the
   * live parts (or `final_text` landed before `[DONE]`), or prose is the latest feed event.
   * No spinner anywhere in that state — the streamed prose is the only progress indicator.
   * Reasoning chunks interleaved with the reply do not bring the spinner back.
   */
  readonly liveReplyStreaming = computed(
    () => this.loading() && isLiveReplyStreaming(this.liveTurnFeed(), this.primaryStreamLiveText()),
  );

  /** Turn spinner allowed (processing row or hosted in the feed preview). */
  readonly liveSpinnerActive = computed(
    () => this.loading() && !this.liveAwaitingHitlReview() && !this.liveReplyStreaming(),
  );

  /**
   * Stick: auto-follow the bottom as the transcript grows.
   * Roam: user has scrolled up; freeze the viewport until they return to the bottom.
   */
  readonly stickMode = signal(true);
  /** True while roaming and a new message / HITL landed below the viewport. */
  readonly hasUnseenBelow = signal(false);
  /** Latest `#chatScroll` scrollHeight (FAB visibility + overflow checks). */
  private readonly scrollHeightSig = signal(0);
  /** Jump FAB: roam and the transcript actually overflows. */
  readonly showJumpToBottom = computed(() =>
    shouldShowJumpToBottom(
      this.stickMode(),
      isChatTranscriptScrollable(this.scrollHeightSig(), this.viewportHeightSig()),
    ),
  );

  // --- Virtual scroll state (see `chat-box-virtual.ts`) ---

  /** Measured or estimated height per persisted row (index-aligned with `persistedRows`). */
  private readonly rowHeights = signal<number[]>([]);
  /** Latest scrollTop of `#chatScroll` (feeds `virtualWindow`). */
  private readonly scrollTopSig = signal(0);
  /** Client height of `#chatScroll` (updated on scroll + ResizeObserver). */
  private readonly viewportHeightSig = signal(0);
  /** Measured height of `bottomInsetElement` (HITL dock); consumes the buffer zone one-for-one. */
  private readonly bottomInsetPx = signal(0);
  /**
   * Buffer zone below the last message (inline `padding-bottom` on `#chatScroll`, written by
   * `syncScrollMetrics`). At stick the latest message rests around mid-viewport instead of flush
   * against the composer; HITL cards docked below the scrollport take up that space.
   */
  readonly bottomBufferPx = computed(() =>
    chatBottomBufferPx(this.viewportHeightSig(), this.bottomInsetPx()),
  );
  /** Last `padding-bottom` written to `#chatScroll` (skip redundant style writes on scroll). */
  private appliedBottomBufferPx = -1;
  /** Inset element currently registered with the scrollport `ResizeObserver`. */
  private observedBottomInset: HTMLElement | null = null;
  /** Slack within this distance of the bottom counts as "at the bottom" (re-locks stick). */
  private readonly stickThresholdPx = computed(() => computeStickThresholdPx(this.bottomBufferPx()));
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
  /** Ignore slack-derived roam while a stick-mode `scrollToBottom` is in flight. */
  private programmaticScroll = false;
  private programmaticScrollUnlockTimer: ReturnType<typeof setTimeout> | null = null;
  private chatScrollEndBound: HTMLElement | null = null;
  /** Last `#chatScroll` scrollTop; a decrease is treated as user scroll-up → roam. */
  private lastScrollTop = 0;
  private prevLoadingForCompletionScroll = false;
  /** Last `streamingFinalText` occupancy seen by the final-response scroll effect. */
  private prevHadStreamingFinalText = false;
  /** After `[DONE]`, follow the persisted markdown layout pass once it takes height. */
  private followFinalResponseAfterMdPass = false;
  /** Last `liveAwaitingHitlReview` seen by the HITL layout-follow effect. */
  private prevLiveAwaitingHitl = false;
  /** Fingerprint tail for streaming scroll dedupe (unified turn feed). */
  private prevStreamFeedKey = '';
  private wasProcessingToolsActive = false;
  /** Stable synonym pick for the “tool building” processing label. */
  private readonly toolPhaseSynonymIndex = signal(0);
  private chatDestroyed = false;
  private convScrollTimeout: ReturnType<typeof setTimeout> | null = null;
  private chatScrollResizeObserver: ResizeObserver | null = null;

  /** Bridges `send-response` DOM events from nested HITL / run-button UI to `sendResponse` output. */
  private readonly onSendResponseDom: EventListener = ((event: Event) => {
    if (this.readOnly()) {
      return;
    }
    const detail = (event as CustomEvent<string>).detail;
    this.sendResponse.emit(typeof detail === 'string' ? detail : String(detail ?? ''));
  }) as EventListener;

  // --- Inputs (parent owns transcript + stream SSE) ---

  /** Full conversation transcript (user, assistant, chain, artifact messages). */
  readonly messages = input<ChatMessage[]>([]);
  /** Sub-agent transcripts: nothing here sends to the agent or restores (only the main agent prompts it). */
  readonly readOnly = input(false);
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
  /** Live reasoning as the streaming preview box or a compact timed pill (Settings → Chat appearance). */
  readonly thinkingDisplay = input<ChatThinkingDisplay>(DEFAULT_CHAT_THINKING_DISPLAY);
  /** Sidebar hub vs main-panel expanded overlay (reserved for layout-specific chrome). */
  readonly layout = input<ChatLayoutMode>('expanded');
  /**
   * Chrome docked directly below the scrollport (the HITL composer dock wrapper). Its height is
   * observed alongside the scrollport and subtracted from the bottom buffer so cards occupy the
   * buffer zone rather than pushing the last message up. Measured in the same `ResizeObserver`
   * callback as the scrollport so the buffer, the pin, and the dock transition stay in lockstep.
   */
  readonly bottomInsetElement = input<HTMLElement | null>(null);

  // --- Outputs (HITL completion + composer send) ---

  /** User submitted a follow-up from an embedded prompt (via `send-response` DOM event). */
  readonly restoreConversation = output<{ userMessageId?: string; userMessageIndex: number }>();
  readonly sendResponse = output<string>();
  /** A row in a turn's edited-files footer was clicked: open its read-only diff tab. */
  readonly openTurnDiff = output<TurnDiffOpenRequest>();
  /** Delete confirmation card completed or dismissed. */
  readonly deleteReviewFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  /** Shell command approval card completed or dismissed. */
  readonly acceptCommandFinished = output<AcceptCommandFinishedEvent>();
  /** Copy-to-workspace confirmation completed or dismissed. */
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

  /** User-turn id / number per persisted row (edited-files footer). */
  readonly turnContexts = computed(() => chatTurnUserContexts(this.persistedRows()));

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

  /** Chronological live feed: thought pills, tool pills, and markdown (briefs + reply). */
  readonly liveTurnFeed = computed(() =>
    buildTurnFeed(
      mergeHitlTrailIntoAuxiliaryTimeline(this.streamingParts(), this.liveHitlArtifacts()),
      this.streamingFinalText(),
    ),
  );

  /** True while the live turn is waiting for the first stream item (prompt prefill). */
  readonly livePrefillProcessing = computed(
    () => this.loading() && this.liveTurnFeed().length === 0,
  );

  /** Spinner kind of the in-flight tool (book / terminal / globe / jot). */
  readonly liveToolSpinnerKind = computed(() =>
    inFlightToolSpinnerKind(this.streamingParts(), this.processingToolsActive()),
  );

  /** What the live turn is doing — same value the conversation list row shows. */
  readonly liveTurnActivity = computed(() =>
    resolveTurnActivity({
      feed: this.liveTurnFeed(),
      primaryLiveText: this.primaryStreamLiveText(),
      toolsActive: this.processingToolsActive(),
      toolKind: this.liveToolSpinnerKind(),
      awaitingReview: this.liveAwaitingHitlReview(),
    }),
  );

  /**
   * The activity the user actually sees: the feed preview's spinner while it hosts one (it dwells
   * on a finished tool pill / thought briefly), otherwise the processing row / cursor / HITL wait.
   * Reported to {@link LiveTurnActivityService} so the conversation list row matches exactly.
   */
  readonly shownTurnActivity = computed(() => {
    if (!this.loading()) {
      return null;
    }
    if (this.liveSpinnerActive() && this.liveFeedHostsSpinner()) {
      return this.liveFeedSpinnerKind();
    }
    return this.liveTurnActivity();
  });

  /** Spinner in the processing row (falls back to the think spinner). */
  readonly processingSpinnerKind = computed(() => {
    const activity = this.liveTurnActivity();
    if (activity === 'prefill') return this.prefillStyle().spinner;
    return turnActivitySpinnerKind(activity) ?? 'think';
  });

  /** This turn's prefill word + spinner, keyed on the conversation and its message count. */
  private readonly prefillStyle = computed(() => {
    const key = `${this.conversationId() ?? ''}:${this.messages().length}`;
    return PREFILL_STYLES[hashChatToolPhaseKey(key) % PREFILL_STYLES.length]!;
  });

  /** Persisted turn feed (timeline + final assistant markdown). */
  turnFeedForRow(row: Extract<ChatDisplayRow, { kind: 'assistant-turn' }>): TurnFeedItem[] {
    return buildTurnFeed(
      mergeHitlTrailIntoAuxiliaryTimeline(
        mergeClaraBriefsFromChainIntoTimeline(
          persistedAuxiliaryStreamTimeline(row.assistant),
          row.chainGroups,
        ),
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

  /**
   * Blinking cursor while prose is the latest live event (hidden once `final_text` lands, and
   * not shown on a finished brief while a later tool is running).
   */
  readonly showStreamingPrimaryCursor = computed(
    () =>
      this.loading() &&
      !(this.streamingFinalText() ?? '').trim() &&
      isProseLatestLiveFeedEvent(this.liveTurnFeed()),
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

  /** Live plan (shown in the composer's plan dock); still shapes the live bubble's chrome. */
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
    if (this.livePrefillProcessing()) {
      return this.prefillStyle().label;
    }
    if (!this.loading()) {
      return THINKING_PROCESSING_LABEL;
    }
    if (this.processingToolsActive()) {
      return TOOL_BUILDING_SYNONYMS[this.toolPhaseSynonymIndex() % TOOL_BUILDING_SYNONYMS.length]!;
    }
    return THINKING_PROCESSING_LABEL;
  });

  readonly processingLabelChars = computed(() => Array.from(this.processingBubbleLabel()));

  constructor(private el: ElementRef<HTMLElement>) {
    effect(() => {
      const conversationId = this.conversationId();
      const activity = this.shownTurnActivity();
      untracked(() => this.shownActivityReporter.report(this, conversationId, activity));
    });

    // Observe scrollport size so virtual window math stays correct when the pane is resized.
    // The HITL dock (grid-rows transition) and the terminal dock (height transition) resize the
    // scrollport a little every frame while they animate — in either direction, and possibly
    // both at once with opposite signs. While stick is on, pin to the bottom synchronously on
    // every notification (no RAF lag → no visible drift during the animation) and schedule the
    // regular follow so the bottom buffer, which tracks the new height on the next change
    // detection pass, is included. Shrinks would otherwise hide the latest content under the
    // revealed chrome; grows clamp `scrollTop`, which `isUserScrollUp` keeps from reading as roam.
    afterNextRender(
      () => {
        const elScroll = this.chatScroll()?.nativeElement;
        if (!elScroll) return;
        this.syncScrollMetrics(elScroll);
        this.lastScrollTop = elScroll.scrollTop;
        this.chatScrollResizeObserver?.disconnect();
        this.chatScrollResizeObserver = new ResizeObserver(() => {
          if (this.chatDestroyed) {
            return;
          }
          const wasStick = this.stickMode();
          this.syncScrollMetrics(elScroll);
          if (wasStick) {
            this.pinScrollToBottomNow(elScroll);
            this.scrollToBottom('instant');
          } else {
            requestAnimationFrame(() => this.applyStickFromViewport(elScroll));
          }
        });
        this.chatScrollResizeObserver.observe(elScroll);
        this.observeBottomInset(this.bottomInsetElement());
        this.chatScrollEndBound?.removeEventListener('scrollend', this.onChatScrollEnd);
        this.chatScrollEndBound = elScroll;
        elScroll.addEventListener('scrollend', this.onChatScrollEnd);
      },
      { injector: this.inj },
    );

    // Track the docked inset element (HITL dock) with the scrollport observer.
    effect(() => {
      const inset = this.bottomInsetElement();
      untracked(() => this.observeBottomInset(inset));
    });

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

    // Auto-scroll: jump on conversation switch; follow or badge on appends per stick/roam.
    effect(() => {
      const id = this.conversationId();
      const msgs = this.messages();
      untracked(() => {
        const convChanged =
          this.scrollTrackedConvId === undefined ? true : this.scrollTrackedConvId !== id;
        if (convChanged) {
          this.scrollTrackedConvId = id;
          this.scrollTrackedMsgLen = msgs.length;
          this.prevLiveAwaitingHitl = false;
          this.enterStickMode();
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
          const decision = decideChatScrollOnAppend({
            stickMode: this.stickMode(),
            added,
            loading: this.loading(),
          });
          if (decision.badge) {
            this.hasUnseenBelow.set(true);
          }
          if (decision.follow) {
            this.debouncedSmoothScrollToBottom();
          }
        }
        this.scrollTrackedMsgLen = msgs.length;
      });
    });

    // During streaming: follow unified feed growth while stick is on.
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

        if (!shouldFollowStreamToken(this.stickMode(), decision.scrollNow)) {
          return;
        }
        this.scrollToBottom('instant');
      });
    });

    // One smooth scroll when a turn finishes loading (stream → persisted).
    effect(() => {
      const loading = this.loading();
      untracked(() => {
        if (loading && !this.prevLoadingForCompletionScroll) {
          this.prevStreamFeedKey = '';
          this.prevHadStreamingFinalText = false;
        }
        if (this.prevLoadingForCompletionScroll && !loading) {
          this.followFinalResponseAfterMdPass = this.stickMode();
          afterNextRender(
            () => {
              if (this.chatDestroyed || !shouldFollowStreamComplete(this.stickMode())) {
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

    // Clean `final_text` can land before `[DONE]` and grow the live markdown after the last token follow.
    effect(() => {
      const finalText = this.streamingFinalText();
      untracked(() => {
        const appeared = didFinalResponseAppear(finalText, this.prevHadStreamingFinalText);
        this.prevHadStreamingFinalText = (finalText ?? '').trim().length > 0;
        if (!appeared || !shouldFollowFinalResponse(this.stickMode())) {
          return;
        }
        afterNextRender(
          () => {
            if (this.chatDestroyed || !shouldFollowFinalResponse(this.stickMode())) {
              return;
            }
            this.scrollToBottom('smooth');
          },
          { injector: this.inj },
        );
      });
    });

    // Stick: re-bottom after HITL review chrome (diff dock) takes layout height.
    effect(() => {
      const awaitingHitl = this.liveAwaitingHitlReview();
      untracked(() => {
        const becameVisible = awaitingHitl && !this.prevLiveAwaitingHitl;
        this.prevLiveAwaitingHitl = awaitingHitl;
        if (!becameVisible || !this.stickMode()) {
          return;
        }
        afterNextRender(
          () => {
            if (this.chatDestroyed || !this.stickMode()) {
              return;
            }
            this.scrollToBottom('instant');
          },
          { injector: this.inj },
        );
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
            if (!this.followFinalResponseAfterMdPass) {
              return;
            }
            this.followFinalResponseAfterMdPass = false;
            afterNextRender(
              () => {
                if (this.chatDestroyed || !shouldFollowFinalResponse(this.stickMode())) {
                  return;
                }
                this.scrollToBottom('smooth');
              },
              { injector: this.inj },
            );
          },
          { injector: this.inj },
        );
      });
    });

    this.el.nativeElement.addEventListener('send-response', this.onSendResponseDom);

    // Tool-phase synonym: pick a new word when a tool batch starts on this turn.
    effect(() => {
      const loading = this.loading();
      const tools = this.processingToolsActive();
      untracked(() => {
        if (loading && tools && !this.wasProcessingToolsActive) {
          const chainN = this.messages().filter((m) => m.role === 'chain').length;
          const key = `${this.conversationId() ?? ''}:${chainN}`;
          this.toolPhaseSynonymIndex.set(hashChatToolPhaseKey(key) % TOOL_BUILDING_SYNONYMS.length);
        }
        this.wasProcessingToolsActive = tools;
      });
    });

    // TTS loading spinner beside playback controls.
    effect(() => {
      this.ttsLoading();
      untracked(() => this.scheduleTtsSpinnerSync());
    });

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
    this.shownActivityReporter.clear(this);
    this.el.nativeElement.removeEventListener('send-response', this.onSendResponseDom);
    this.chatScrollResizeObserver?.disconnect();
    this.chatScrollResizeObserver = null;
    this.observedBottomInset = null;
    this.chatScrollEndBound?.removeEventListener('scrollend', this.onChatScrollEnd);
    this.chatScrollEndBound = null;
    this.releaseProgrammaticScrollLock();
    if (this.convScrollTimeout != null) {
      clearTimeout(this.convScrollTimeout);
      this.convScrollTimeout = null;
    }
    if (this.scrollSmoothDebounceTimer != null) {
      clearTimeout(this.scrollSmoothDebounceTimer);
      this.scrollSmoothDebounceTimer = null;
    }
    void this.ngxSpinner.hide(SPINNER_CHAT_TTS);
  }

  /** Template `(scroll)` handler: roam immediately on scroll-up; coalesce virtual-window updates. */
  onChatScroll(): void {
    const box = this.chatScroll()?.nativeElement;
    if (!box) return;
    this.applyStickFromViewport(box);
    cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = requestAnimationFrame(() => {
      const next = this.chatScroll()?.nativeElement;
      if (!next) return;
      this.syncScrollMetrics(next);
      this.scheduleMeasureVisibleRows();
    });
  }

  /** Wheel-up leaves stick immediately so a live stream cannot yank the viewport back down. */
  onChatWheel(event: WheelEvent): void {
    const box = this.chatScroll()?.nativeElement;
    if (
      event.deltaY < 0 &&
      box &&
      isChatTranscriptScrollable(box.scrollHeight, box.clientHeight)
    ) {
      this.enterRoamFromUser();
    }
  }

  /** Jump-to-bottom FAB: re-enter stick and smooth-scroll to the latest content. */
  onJumpToBottom(): void {
    this.enterStickMode();
    this.scrollToBottom('smooth');
  }

  private readonly onChatScrollEnd = (): void => {
    this.releaseProgrammaticScrollLock();
    const box = this.chatScroll()?.nativeElement;
    if (box) {
      this.applyStickFromViewport(box);
    }
  };

  private enterStickMode(): void {
    this.stickMode.set(true);
    this.hasUnseenBelow.set(false);
  }

  /** User scroll-up: freeze the viewport and abort any in-flight stick follow. */
  private enterRoamFromUser(): void {
    const box = this.chatScroll()?.nativeElement;
    if (!box || !isChatTranscriptScrollable(box.scrollHeight, box.clientHeight)) {
      this.enterStickMode();
      return;
    }
    this.stickMode.set(false);
    this.releaseProgrammaticScrollLock();
    cancelAnimationFrame(this.scrollToBottomRaf);
    this.scrollToBottomRaf = 0;
    if (this.scrollSmoothDebounceTimer != null) {
      clearTimeout(this.scrollSmoothDebounceTimer);
      this.scrollSmoothDebounceTimer = null;
    }
  }

  private beginProgrammaticScrollLock(behavior: ScrollBehavior): void {
    this.programmaticScroll = true;
    if (this.programmaticScrollUnlockTimer != null) {
      clearTimeout(this.programmaticScrollUnlockTimer);
    }
    const unlockMs = behavior === 'smooth' ? 450 : 64;
    this.programmaticScrollUnlockTimer = setTimeout(() => {
      this.programmaticScrollUnlockTimer = null;
      this.programmaticScroll = false;
      const box = this.chatScroll()?.nativeElement;
      if (box) {
        this.applyStickFromViewport(box);
      }
    }, unlockMs);
  }

  private releaseProgrammaticScrollLock(): void {
    this.programmaticScroll = false;
    if (this.programmaticScrollUnlockTimer != null) {
      clearTimeout(this.programmaticScrollUnlockTimer);
      this.programmaticScrollUnlockTimer = null;
    }
  }

  /**
   * Refresh scroll signals from the live DOM. Measures the docked inset and writes the bottom
   * buffer padding first so `scrollHeight` (and any slack / pin decision made by the caller)
   * already reflects the new buffer — no frame where the padding lags the dock height.
   */
  private syncScrollMetrics(box: HTMLElement): void {
    const inset = this.bottomInsetElement()?.offsetHeight ?? 0;
    this.bottomInsetPx.set(inset);
    this.applyBottomBuffer(box, chatBottomBufferPx(box.clientHeight, inset));
    this.scrollTopSig.set(box.scrollTop);
    this.viewportHeightSig.set(box.clientHeight);
    this.scrollHeightSig.set(box.scrollHeight);
  }

  /** Single writer for the scrollport's `padding-bottom` (the buffer zone). */
  private applyBottomBuffer(box: HTMLElement, px: number): void {
    if (px === this.appliedBottomBufferPx) {
      return;
    }
    this.appliedBottomBufferPx = px;
    box.style.paddingBottom = `${px}px`;
  }

  /** Swap the inset element registered with the scrollport `ResizeObserver`. */
  private observeBottomInset(next: HTMLElement | null): void {
    const observer = this.chatScrollResizeObserver;
    if (!observer) {
      return;
    }
    if (this.observedBottomInset && this.observedBottomInset !== next) {
      observer.unobserve(this.observedBottomInset);
    }
    this.observedBottomInset = next;
    if (next) {
      observer.observe(next);
    }
  }

  /**
   * Stick/roam from the live viewport. Scroll-up always wins, including during a
   * programmatic follow; the lock only ignores slack while a smooth jump is in flight.
   */
  private applyStickFromViewport(box: HTMLElement): void {
    const top = box.scrollTop;
    this.syncScrollMetrics(box);
    const slack = scrollSlackPx(box.scrollHeight, top, box.clientHeight);
    const intent = decideStickAfterUserScroll({
      scrolledUp: isUserScrollUp(top, this.lastScrollTop, slack),
      scrolledDown: top > this.lastScrollTop + 1,
      nearBottom: isStickFromSlack(slack, this.stickThresholdPx()),
      programmatic: this.programmaticScroll,
      stickMode: this.stickMode(),
      scrollable: isChatTranscriptScrollable(box.scrollHeight, box.clientHeight),
    });
    this.lastScrollTop = top;
    if (intent === 'roam') {
      this.enterRoamFromUser();
      return;
    }
    if (intent === 'stick') {
      this.enterStickMode();
    }
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
          this.syncScrollMetrics(root);
          if (!isChatTranscriptScrollable(root.scrollHeight, root.clientHeight) && !this.stickMode()) {
            this.enterStickMode();
          }
          const rowsLen = this.persistedRows().length;
          let heightChanged = false;
          for (const wrap of root.querySelectorAll<HTMLElement>('[data-chat-row]')) {
            const idx = Number(wrap.dataset['chatRow']);
            if (!Number.isFinite(idx) || idx < 0 || idx >= rowsLen) continue;
            const measured = wrap.offsetHeight;
            if (measured < 8) continue;
            this.rowHeights.update((arr) => {
              if (idx >= arr.length) return arr;
              if (Math.abs((arr[idx] ?? 0) - measured) < 2) return arr;
              heightChanged = true;
              const next = [...arr];
              next[idx] = measured;
              return next;
            });
          }
          if (heightChanged && this.stickMode()) {
            this.pinScrollToBottomNow(root);
          }
        },
      },
      { injector: this.inj },
    );
  }

  /** Batches rapid message appends into one smooth scroll (80 ms). Skips if roam won the race. */
  private debouncedSmoothScrollToBottom(): void {
    if (this.scrollSmoothDebounceTimer != null) {
      clearTimeout(this.scrollSmoothDebounceTimer);
    }
    this.scrollSmoothDebounceTimer = setTimeout(() => {
      this.scrollSmoothDebounceTimer = null;
      if (this.chatDestroyed || !this.stickMode()) {
        return;
      }
      this.scrollToBottom('smooth');
    }, 80);
  }

  /**
   * Synchronous instant pin used from the `ResizeObserver` while stick is on. Runs inside the
   * observer callback (after layout, before paint) so a scrollport that is mid-transition never
   * paints a frame with the latest content hidden. Holds the programmatic lock so the resulting
   * `scroll` event cannot be mistaken for user intent, and records the new `scrollTop` so the
   * next event compares against the pinned position rather than the pre-resize one.
   */
  private pinScrollToBottomNow(box: HTMLElement): void {
    if (this.chatDestroyed || !this.stickMode()) {
      return;
    }
    this.beginProgrammaticScrollLock('instant');
    box.scrollTop = box.scrollHeight;
    this.lastScrollTop = box.scrollTop;
    this.syncScrollMetrics(box);
  }

  /** Scroll `#chatScroll` (or `.chat-box` fallback) to `scrollHeight` and refresh measurements. */
  private scrollToBottom(behavior: ScrollBehavior): void {
    if (this.chatDestroyed || !this.stickMode()) {
      return;
    }
    this.beginProgrammaticScrollLock(behavior);
    cancelAnimationFrame(this.scrollToBottomRaf);
    this.scrollToBottomRaf = requestAnimationFrame(() => {
      if (this.chatDestroyed || !this.stickMode()) {
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
        this.lastScrollTop = box.scrollTop;
        this.syncScrollMetrics(box);
      }
      this.scheduleMeasureVisibleRows();
    });
  }

  /** Persisted-turn planner panel context (mirrors `livePlanPanel` for saved turns). */
  planPanelForTurn(row: ChatDisplayRow): ReturnType<typeof planPanelContext> {
    if (row.kind !== 'assistant-turn') return null;
    return planPanelContext(row.assistant?.planner, row.artifacts);
  }
}
