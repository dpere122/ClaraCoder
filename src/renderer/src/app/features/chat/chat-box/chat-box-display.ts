import type {
  ConversationMessage,
  DiffReviewStatus,
  PlanConfirmPayload,
  AgentQuestionPayload,
  PlannerProgress,
  StreamPart,
  TurnFeedItem,
} from '@shared/index';
import {
  CLARA_OUTER_BRIEF_STREAM_TAG,
  isClaraOuterBriefStreamTag,
  isHitlTrailStreamTag,
  isInFlightToolPart,
  isPrimaryAssistantStreamTag,
  isReadToolPreviewStreamTag,
  isWorkspaceReadToolLabel,
  PLANNER_STREAM_TAG,
} from '@shared/index';

export const DEFAULT_AUXILIARY_STREAM_PANEL_TITLE = 'Model reasoning & tools';
import {
  attachedFileDisplayLabel,
  attachedFileRefFromText,
  isAttachedFileText,
} from '../chat-context-bar/chat-attached-file-display';

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
  'forming',
] as const;

/** Same shape as `ConversationMessage` in `typings.d.ts` (single source for save/load). */
export type ChatMessage = ConversationMessage;
type UserMessage = Extract<ChatMessage, { role: 'user' }>;
type ChainMessage = Extract<ChatMessage, { role: 'chain' }>;
export type ArtifactMessage = Extract<
  ChatMessage,
  | { role: 'diff' }
  | { role: 'accept_command' }
  | { role: 'copy_confirm' }
  | { role: 'delete_confirm' }
  | { role: 'plan_confirm' }
  | { role: 'agent_question' }
  | { role: 'theme_proposal' }
  | { role: 'staged_transfer_batch' }
>;

export interface PlanPanelContext {
  planner: PlannerProgress;
  planConfirm?: PlanConfirmPayload;
  planConfirmReviewStatus?: DiffReviewStatus;
  planConfirmReviewSummary?: string;
  agentQuestion?: AgentQuestionPayload;
  agentQuestionReviewStatus?: DiffReviewStatus;
  agentQuestionReviewSummary?: string;
}

function plannerFromPlanConfirm(payload: PlanConfirmPayload): PlannerProgress {
  return {
    streamTag: PLANNER_STREAM_TAG,
    phase: 'planning',
    planReady: true,
    steps: payload.steps.map((text, i) => ({
      id: `step-${i + 1}`,
      text,
      state: 'pending' as const,
    })),
  };
}

/** Merge live or persisted planner progress with optional plan-confirm / agent-question HITL artifacts. */
export function planPanelContext(
  planner: PlannerProgress | null | undefined,
  artifacts: readonly ArtifactMessage[],
): PlanPanelContext | null {
  const planArtifact = artifacts.find((a): a is Extract<ArtifactMessage, { role: 'plan_confirm' }> => a.role === 'plan_confirm');
  const questionArtifact = artifacts.find(
    (a): a is Extract<ArtifactMessage, { role: 'agent_question' }> => a.role === 'agent_question',
  );
  if (planner) {
    return {
      planner,
      planConfirm: planArtifact?.payload,
      planConfirmReviewStatus: planArtifact?.reviewStatus,
      planConfirmReviewSummary: planArtifact?.reviewSummary,
      agentQuestion: questionArtifact?.payload,
      agentQuestionReviewStatus: questionArtifact?.reviewStatus,
      agentQuestionReviewSummary: questionArtifact?.reviewSummary,
    };
  }
  if (planArtifact) {
    return {
      planner: plannerFromPlanConfirm(planArtifact.payload),
      planConfirm: planArtifact.payload,
      planConfirmReviewStatus: planArtifact.reviewStatus ?? 'pending',
      planConfirmReviewSummary: planArtifact.reviewSummary,
      agentQuestion: questionArtifact?.payload,
      agentQuestionReviewStatus: questionArtifact?.reviewStatus,
      agentQuestionReviewSummary: questionArtifact?.reviewSummary,
    };
  }
  return null;
}

/** True when the unified plan checklist should render for this turn. */
export function turnHasPlanPanel(
  planner: PlannerProgress | null | undefined,
  artifacts: readonly ArtifactMessage[],
): boolean {
  return planPanelContext(planner, artifacts) != null;
}

/** Plan is the terminal UI — no streamed final prose yet — so present like a completed turn. */
export function liveTurnPresentationSettled(
  planVisible: boolean,
  rawPrimaryText: string,
  livePrimaryText: string,
): boolean {
  if (!planVisible) {
    return false;
  }
  return rawPrimaryText.trim().length === 0 && livePrimaryText.trim().length === 0;
}

/** Plan approval + clarifying questions are rendered inside the unified plan panel — omit from the HITL detail stack. */
export function hitlArtifactsExcludingPlanConfirm(artifacts: readonly ArtifactMessage[]): ArtifactMessage[] {
  return artifacts.filter((a) => a.role !== 'plan_confirm' && a.role !== 'agent_question' && a.role !== 'theme_proposal');
}

export function planPanelCompleteCount(planner: PlannerProgress): number {
  return planner.steps.filter((s) => s.state === 'complete').length;
}

export interface ToolChainGroup {
  key: string;
  rows: ChainMessage[];
  toolCallCount: number;
}

export type ChatDisplayRow =
  | { kind: 'user'; msg: UserMessage }
  | {
      kind: 'assistant-turn';
      assistant: Extract<ChatMessage, { role: 'assistant' }> | null;
      chainGroups: ToolChainGroup[];
      artifacts: ArtifactMessage[];
    };

/** Inline image data URLs attached to a user turn (from `image_url` blocks). */
export function userMessageImageUrls(msg: UserMessage): string[] {
  const parts = msg.structuredContent;
  if (!parts?.length) {
    return [];
  }
  const urls: string[] = [];
  for (const part of parts) {
    const rec = part as { type?: unknown; image_url?: { url?: unknown } };
    if (String(rec.type ?? '') === 'image_url') {
      const url = rec.image_url?.url;
      if (typeof url === 'string' && url) {
        urls.push(url);
      }
    }
  }
  return urls;
}

/** Display labels for non-image file attachments in a user turn. */
export function userMessageAttachedFiles(msg: UserMessage): string[] {
  const parts = msg.structuredContent;
  if (!parts?.length) {
    return [];
  }
  const files: string[] = [];
  for (const part of parts) {
    const rec = part as { type?: unknown; text?: unknown };
    if (String(rec.type ?? '') === 'text' && typeof rec.text === 'string' && isAttachedFileText(rec.text)) {
      const ref = attachedFileRefFromText(rec.text);
      if (ref) {
        files.push(attachedFileDisplayLabel(ref));
      }
    }
  }
  return files;
}

/** Raw attachment text after the prefix (path or path + line-range hint). */
export function userMessageAttachedFileRefs(msg: UserMessage): string[] {
  const parts = msg.structuredContent;
  if (!parts?.length) {
    return [];
  }
  const files: string[] = [];
  for (const part of parts) {
    const rec = part as { type?: unknown; text?: unknown };
    if (String(rec.type ?? '') === 'text' && typeof rec.text === 'string' && isAttachedFileText(rec.text)) {
      const ref = attachedFileRefFromText(rec.text);
      if (ref) {
        files.push(ref);
      }
    }
  }
  return files;
}

/** Pixels from the bottom of `#chatScroll` to treat as stick mode. */
export const SCROLL_BOTTOM_PIN_THRESHOLD_PX = 48;

/**
 * Fraction of the scrollport height kept empty below the last message — the buffer zone
 * above the composer. At stick, the latest message therefore rests around mid-viewport.
 */
export const CHAT_BOTTOM_BUFFER_RATIO = 0.5;

/**
 * Bottom buffer in px for a given scrollport height (0 until the viewport is measured).
 *
 * `insetPx` is chrome docked directly below the scrollport (HITL cards in the composer dock)
 * that should occupy the buffer zone instead of pushing the transcript up: the buffer is sized
 * as if the inset were part of the viewport, then the inset is subtracted one-for-one, so the
 * last message stays put and the card slots into the space beneath it.
 */
export function chatBottomBufferPx(
  viewportHeightPx: number,
  insetPx = 0,
  ratio = CHAT_BOTTOM_BUFFER_RATIO,
): number {
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) {
    return 0;
  }
  const inset = Number.isFinite(insetPx) && insetPx > 0 ? insetPx : 0;
  return Math.max(0, Math.round((viewportHeightPx + inset) * ratio - inset));
}

/**
 * Stick threshold: the whole buffer zone counts as "at the bottom", so scrolling back into
 * the buffer re-locks auto-follow. Never smaller than the legacy pixel pin.
 */
export function stickThresholdPx(
  bottomBufferPx: number,
  minPx = SCROLL_BOTTOM_PIN_THRESHOLD_PX,
): number {
  return Math.max(minPx, bottomBufferPx);
}

export function isScrollWorthyAppendMessage(m: ChatMessage): boolean {
  return (
    m.role === 'user' ||
    m.role === 'assistant' ||
    m.role === 'chain' ||
    m.role === 'diff' ||
    m.role === 'delete_confirm' ||
    m.role === 'copy_confirm' ||
    m.role === 'accept_command' ||
    m.role === 'plan_confirm' ||
    m.role === 'agent_question' ||
    m.role === 'theme_proposal' ||
    m.role === 'staged_transfer_batch'
  );
}

/** Distance from the bottom of a scrollport (`scrollHeight - scrollTop - clientHeight`). */
export function scrollSlackPx(scrollHeight: number, scrollTop: number, clientHeight: number): number {
  return scrollHeight - scrollTop - clientHeight;
}

/** True when the transcript can actually scroll (ignore 1px subpixel overflow). */
export function isChatTranscriptScrollable(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight > 1;
}

/** Jump-to-bottom FAB: roam and the transcript must overflow. */
export function shouldShowJumpToBottom(stickMode: boolean, scrollable: boolean): boolean {
  return !stickMode && scrollable;
}

/** True when slack is within the stick threshold (user is at / near the bottom). */
export function isStickFromSlack(
  slackPx: number,
  thresholdPx = SCROLL_BOTTOM_PIN_THRESHOLD_PX,
): boolean {
  return slackPx <= thresholdPx;
}

/** How the transcript should react to newly appended messages. */
export interface ChatScrollAppendDecision {
  /** Scroll the transcript to the bottom. */
  follow: boolean;
  /** Show the unseen-message badge on the jump-to-bottom button. */
  badge: boolean;
}

/**
 * Stick follows new messages and HITL. Roam never auto-scrolls — including on a
 * user send — and badges the FAB so the reader can jump back when ready.
 */
export function decideChatScrollOnAppend(input: {
  stickMode: boolean;
  added: readonly ChatMessage[];
  loading: boolean;
}): ChatScrollAppendDecision {
  const none: ChatScrollAppendDecision = { follow: false, badge: false };
  if (!input.added.some(isScrollWorthyAppendMessage)) {
    return none;
  }
  const hasUser = input.added.some((m) => m.role === 'user');
  const hasHitl = input.added.some(isHitlActivationMessage);

  if (!input.stickMode) {
    return { follow: false, badge: true };
  }

  // Stick: follow user/HITL even mid-stream; other worthy appends wait until the
  // turn is not loading (live feed growth is handled by the stream-token path).
  if (!input.loading || hasUser || hasHitl) {
    return { follow: true, badge: false };
  }
  return none;
}

/**
 * True when a `scrollTop` decrease came from the user (wheel, scrollbar drag, keyboard) rather
 * than a layout clamp. When the scrollport grows or its content shrinks (HITL dock or terminal
 * collapsing, live bubble swapped for the persisted row) the browser clamps `scrollTop` to the new
 * maximum and fires a `scroll` event: `scrollTop` drops, but slack lands at zero — a position a
 * real scroll-up can never reach. Treating that as intent would knock the reader out of stick.
 */
export function isUserScrollUp(scrollTop: number, lastScrollTop: number, slackPx: number): boolean {
  return scrollTop + 1 < lastScrollTop && slackPx > 1;
}

/** Outcome of a scroll event for stick/roam. `keep` leaves the current mode unchanged. */
export type ChatStickScrollIntent = 'stick' | 'roam' | 'keep';

/**
 * Any user scroll-up leaves stick immediately once the transcript overflows.
 * A non-scrollable transcript stays in stick — roam is meaningless until overflow.
 * Re-stick only when the user scrolls back to the bottom (or is already stick and
 * still near it). Resize / programmatic follow must not flip roam back to stick.
 */
export function decideStickAfterUserScroll(input: {
  scrolledUp: boolean;
  scrolledDown: boolean;
  nearBottom: boolean;
  programmatic: boolean;
  stickMode: boolean;
  scrollable: boolean;
}): ChatStickScrollIntent {
  if (!input.scrollable) {
    return 'stick';
  }
  if (input.scrolledUp) {
    return 'roam';
  }
  if (input.programmatic) {
    return 'keep';
  }
  if (input.nearBottom && (input.stickMode || input.scrolledDown)) {
    return 'stick';
  }
  return 'keep';
}

/** Stream completion should re-bottom only while stick is on. */
export function shouldFollowStreamComplete(stickMode: boolean): boolean {
  return stickMode;
}

/** Backend `final_text` (or persisted clean reply) just became available. */
export function didFinalResponseAppear(
  finalText: string | undefined,
  prevHadFinalText: boolean,
): boolean {
  return (finalText ?? '').trim().length > 0 && !prevHadFinalText;
}

/** Final-response autoscroll follows the same stick rule as stream completion. */
export function shouldFollowFinalResponse(stickMode: boolean): boolean {
  return stickMode;
}

/** Live feed growth should re-bottom only while stick is on and the feed actually changed. */
export function shouldFollowStreamToken(stickMode: boolean, scrollNow: boolean): boolean {
  return stickMode && scrollNow;
}

/** Returning to stick (scroll-to-bottom or FAB) always clears the unseen-message badge. */
export function unseenBelowAfterScroll(stickMode: boolean, currentUnseen: boolean): boolean {
  return stickMode ? false : currentUnseen;
}

/** Tracks streaming scroll dedupe for primary vs auxiliary (reasoning/tools) growth. */
export interface StreamingScrollState {
  prevPrimaryKey: string;
  prevAuxKey: string;
  prevAuxPanelVisible: boolean;
}

export interface StreamingScrollInput {
  primaryKey: string;
  auxKey: string;
  /** True only after the live details panel has revealed and taken layout height. */
  auxPanelVisible: boolean;
}

export interface StreamingScrollDecision {
  /** Primary reply grew — scroll immediately. */
  scrollNow: boolean;
  /** Live details panel appeared or reasoning/tools stream started — scroll after layout. */
  scrollAfterLayout: boolean;
  next: StreamingScrollState;
}

/**
 * Whether a pinned chat should follow an in-flight stream update.
 * `auxPanelVisible` should flip true only when the live details panel takes layout
 * height (overflow reveal), not when trail parts first mount while still pending.
 */
export function decideInstantScrollOnStreamingUpdate(
  input: StreamingScrollInput,
  prev: StreamingScrollState,
): StreamingScrollDecision {
  const primaryChanged = input.primaryKey !== prev.prevPrimaryKey;
  const auxChanged = input.auxKey !== prev.prevAuxKey;
  const auxPanelBecameVisible = input.auxPanelVisible && !prev.prevAuxPanelVisible;

  return {
    scrollNow: primaryChanged,
    scrollAfterLayout: auxPanelBecameVisible,
    next: {
      prevPrimaryKey: primaryChanged ? input.primaryKey : prev.prevPrimaryKey,
      prevAuxKey: auxChanged ? input.auxKey : prev.prevAuxKey,
      prevAuxPanelVisible: input.auxPanelVisible,
    },
  };
}

/** Review / confirmation cards (HITL): follow in stick mode, including while a reply is still streaming. */
export function isHitlActivationMessage(m: ChatMessage): boolean {
  return (
    m.role === 'diff' ||
    m.role === 'delete_confirm' ||
    m.role === 'copy_confirm' ||
    m.role === 'accept_command' ||
    m.role === 'plan_confirm' ||
    m.role === 'agent_question' ||
    m.role === 'theme_proposal' ||
    m.role === 'staged_transfer_batch'
  );
}

/** HITL card still awaiting user action (blocks the live streaming row until resolved). */
export function isPendingHitlArtifact(m: ArtifactMessage): boolean {
  return (m.reviewStatus ?? 'pending') === 'pending';
}

export function turnHasPendingHitlArtifacts(artifacts: readonly ArtifactMessage[]): boolean {
  return artifacts.some(isPendingHitlArtifact);
}

/**
 * Pending HITL artifacts for the composer dock: latest assistant-turn that still has
 * unresolved reviews (includes plan_confirm / agent_question).
 */
export function pendingHitlArtifactsForDock(messages: readonly ChatMessage[]): ArtifactMessage[] {
  const rows = buildChatDisplayRows([...messages]);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind !== 'assistant-turn') {
      continue;
    }
    const pending = row.artifacts.filter(isPendingHitlArtifact);
    if (pending.length > 0) {
      return pending;
    }
    if (row.assistant || row.artifacts.length > 0) {
      return [];
    }
  }
  return [];
}

/** In-flight assistant turn for the live bubble (no final ``assistant`` message yet). */
export function resolveLiveAssistantTurn(
  rows: readonly ChatDisplayRow[],
): Extract<ChatDisplayRow, { kind: 'assistant-turn' }> | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === 'assistant-turn' && !row.assistant) {
      return row;
    }
    if (row?.kind === 'user') {
      return null;
    }
  }
  return null;
}

/**
 * True when prose (reply or Clara brief) is the latest live feed event.
 * HITL change rows are display-time and always merge to the end of the live timeline, so
 * they are skipped — otherwise a single edit review would keep the spinner on for the rest
 * of the turn and hide the streaming cursor.
 */
export function isProseLatestLiveFeedEvent(items: readonly TurnFeedItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'tool' && isHitlTrailStreamTag(item.part.streamTag)) {
      continue;
    }
    return item.kind === 'markdown';
  }
  return false;
}

/**
 * True while the reply (or a Clara brief) is being generated, so no spinner should show.
 * Primary (`agent`) prose present in the live parts is the authoritative signal: tool calls
 * and nudges retag it away (`clear_primary_stream` / `promote_primary_to_nudge`), so the
 * spinner returns exactly when tools take over. Falls back to "prose is the latest event"
 * for backend-emitted briefs that land as complete `clara` rows.
 */
export function isLiveReplyStreaming(
  items: readonly TurnFeedItem[],
  primaryLiveText: string,
): boolean {
  return primaryLiveText.trim().length > 0 || isProseLatestLiveFeedEvent(items);
}

/**
 * What an in-flight turn is doing right now, as one value shared by the live processing row
 * and the conversation list: `prefill` (waiting for the first stream item), `think`
 * (reasoning), `read` / `write` (workspace read vs other tools), `reply` (prose streaming —
 * no spinner, the cursor is the indicator) and `review` (blocked on a HITL card).
 */
export type TurnActivity = 'prefill' | 'think' | 'read' | 'write' | 'reply' | 'review';

/** True while the latest in-flight tool part is a workspace read (book spinner instead of jot). */
export function isReadToolInFlight(parts: readonly StreamPart[], toolsActive: boolean): boolean {
  if (!toolsActive) {
    return false;
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (!isInFlightToolPart(part)) {
      continue;
    }
    return isWorkspaceReadToolLabel(part.label) || isReadToolPreviewStreamTag(part.streamTag);
  }
  return false;
}

export function resolveTurnActivity(state: {
  feed: readonly TurnFeedItem[];
  primaryLiveText: string;
  toolsActive: boolean;
  readToolActive: boolean;
  awaitingReview: boolean;
}): TurnActivity {
  if (state.awaitingReview) {
    return 'review';
  }
  if (state.feed.length === 0) {
    return 'prefill';
  }
  if (isLiveReplyStreaming(state.feed, state.primaryLiveText)) {
    return 'reply';
  }
  if (state.toolsActive) {
    return state.readToolActive ? 'read' : 'write';
  }
  return 'think';
}

/** Spinner image for a spinning activity (`null` for `reply` / `review`). */
export function turnActivitySpinnerSrc(activity: TurnActivity): string | null {
  switch (activity) {
    case 'prefill':
      return 'spinner-prefill.svg';
    case 'think':
      return 'spinner.svg';
    case 'read':
      return 'spinner-read.svg';
    case 'write':
      return 'spinner-jot.svg';
    default:
      return null;
  }
}

/** Small stable hash for synonym index (FNV-1a 32-bit). */
export function hashChatToolPhaseKey(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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

export function filterLiveToolChainGroups(groups: ToolChainGroup[]): ToolChainGroup[] {
  return groups.filter((group) => group.rows.length > 0);
}

function oneLineTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Primary (`agent`) prose from the latest model step — after tool multiplex rows split segments. */
export function latestPrimaryStreamSegmentText(parts: readonly StreamPart[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (isPrimaryAssistantStreamTag(part.streamTag)) {
      return part.text;
    }
  }
  return '';
}

/**
 * Extract the latest non-empty line from streaming text for the panel title.
 * Used for Clara status lines while tools run and the main reply zone is empty.
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

/**
 * Live markdown zone: prefer backend `final_text`, else stream the latest primary agent segment.
 * Pre-tool planning prose is promoted to a Clara brief via SSE ``clear_primary_stream``, so
 * post-tool primary can stream after tools finish (comet / thinking spinner again).
 */
export function resolvePrimaryStreamLiveText(
  streamingFinalText: string | undefined,
  streamingParts: readonly StreamPart[],
  _processingToolsActive = false,
): string {
  const final = streamingFinalText?.trim();
  if (final) {
    return final;
  }
  return latestPrimaryStreamSegmentText(streamingParts).trim();
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

/**
 * Older transcripts stored Clara briefs as chain rows. Fold them into the turn feed
 * unless the auxiliary timeline already has `clara` parts.
 */
export function mergeClaraBriefsFromChainIntoTimeline(
  timeline: readonly StreamPart[],
  groups: readonly ToolChainGroup[],
): StreamPart[] {
  const existing = [...timeline];
  if (existing.some((p) => isClaraOuterBriefStreamTag(p.streamTag))) {
    return existing;
  }
  const extras: StreamPart[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      if (!isClaraOuterBriefStreamTag(row.streamTag) || !row.text.trim()) {
        continue;
      }
      extras.push({
        streamTag: CLARA_OUTER_BRIEF_STREAM_TAG,
        label: row.label || 'Clara',
        text: row.text,
      });
    }
  }
  return extras.length ? [...extras, ...existing] : existing;
}

/** User turn that an assistant-turn row answers (end-of-turn edit review). */
export interface ChatTurnUserContext {
  /** Restore / journal id of the turn's user message (absent on old transcripts). */
  userMessageId: string | null;
  /** 1-based count of user messages up to and including this turn. */
  turnNumber: number;
}

/** Per-row user-turn context, index-aligned with `rows`; null for user rows and turns before any prompt. */
export function chatTurnUserContexts(rows: readonly ChatDisplayRow[]): (ChatTurnUserContext | null)[] {
  let turnNumber = 0;
  let userMessageId: string | null = null;
  return rows.map((row) => {
    if (row.kind === 'user') {
      turnNumber++;
      userMessageId = row.msg.id ?? null;
      return null;
    }
    return turnNumber > 0 ? { userMessageId, turnNumber } : null;
  });
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
    if (
      msg.role === 'diff' ||
      msg.role === 'copy_confirm' ||
      msg.role === 'delete_confirm' ||
      msg.role === 'plan_confirm' ||
      msg.role === 'agent_question' ||
      msg.role === 'theme_proposal' ||
      msg.role === 'staged_transfer_batch'
    ) {
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
