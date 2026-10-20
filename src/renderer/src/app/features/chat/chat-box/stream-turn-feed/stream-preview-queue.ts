import {
  isHitlTrailStreamTag,
  isToolTrailStatusStreamTag,
  toolPillLabel,
  toolStatusStreamPartMeta,
  type TurnFeedItem,
} from '@shared/index';
import { toolSpinnerKind, type ToolSpinnerKind } from '../tool-spinner-kind';

/** Min time the live preview pane stays open before a contending event can become a chip. */
export const PREVIEW_OPEN_DWELL_MS = 450;

/** After the current preview text stops growing, wait this long before committing when inbound is waiting. */
export const PREVIEW_IDLE_MS = 120;

/** Min time a dashed inbound label must be painted before the current preview can commit. */
export const PREVIEW_INBOUND_ANNOUNCE_MS = 160;

export type SplitQueuedFeed = {
  committed: TurnFeedItem[];
  current: TurnFeedItem | undefined;
  inbound: TurnFeedItem[];
};

export type FeedDisplayRole = 'chip' | 'preview' | 'hidden' | 'markdown';

export type PreviewCommitDecision = { action: 'stay' } | { action: 'commit' } | { action: 'flush' } | { action: 'wait'; delayMs: number };

/** Thought / nudge / tool rows go through the live preview queue. Markdown (reply and Clara briefs) does not. */
export function isQueueableFeedItem(item: TurnFeedItem): boolean {
  return item.kind === 'thought' || item.kind === 'nudge' || item.kind === 'tool';
}

/** HITL trail rows skip the preview pane (dwell 0) so they still appear in arrival order. */
export function isZeroDwellQueueItem(item: TurnFeedItem): boolean {
  return item.kind === 'tool' && isHitlTrailStreamTag(item.part.streamTag);
}

/** Consecutive in-flight tools share one preview chip; HITL never joins the batch. */
export function isToolBatchMember(item: TurnFeedItem): boolean {
  return item.kind === 'tool' && !isZeroDwellQueueItem(item);
}

/**
 * True when `item` joins the live tool batch led by `lead`: parallel calls from one LLM step.
 * A tool from a later step starts a new pill even with no thought or prose in between (models
 * whose reasoning is encrypted stream nothing between steps). Rows without a backend
 * `toolBatch` (subprocess output, older backends) join whatever batch is open.
 */
export function isSameToolBatch(lead: TurnFeedItem, item: TurnFeedItem): boolean {
  if (!isToolBatchMember(lead) || !isToolBatchMember(item)) {
    return false;
  }
  const a = lead.kind === 'tool' ? lead.part.toolBatch : undefined;
  const b = item.kind === 'tool' ? item.part.toolBatch : undefined;
  return !a || !b || a === b;
}

/** Inbound rows that share the current preview's tool batch. */
function currentBatchInbound(current: TurnFeedItem, inbound: readonly TurnFeedItem[]): TurnFeedItem[] {
  const out: TurnFeedItem[] = [];
  for (const item of inbound) {
    if (!isSameToolBatch(current, item)) {
      break;
    }
    out.push(item);
  }
  return out;
}

/** Stable id for in-place text growth vs a new feed event. */
export function queueableFeedIdentity(item: TurnFeedItem): string {
  if (item.kind === 'markdown') {
    return `md:${item.text.length}`;
  }
  return `${item.kind}:${item.part.streamTag}`;
}

export function firstQueueableIdentity(items: readonly TurnFeedItem[]): string | null {
  const first = items.find(isQueueableFeedItem);
  return first ? queueableFeedIdentity(first) : null;
}

export function queueableItems(items: readonly TurnFeedItem[]): TurnFeedItem[] {
  return items.filter(isQueueableFeedItem);
}

export function previewItemText(item: TurnFeedItem): string {
  return item.kind === 'markdown' ? item.text : item.part.text;
}

export function previewShowsBody(item: TurnFeedItem | undefined): boolean {
  return item?.kind === 'thought' || item?.kind === 'nudge';
}

/** Where the live turn spinner renders while the preview slot is open. */
export type PreviewSpinnerHost = 'header' | 'pill';

/**
 * While a live preview is open the turn spinner leaves the processing row and moves into
 * it: beside the thought / nudge header, or inside the running tool pill (read or write spinner).
 * `null` when there is no open preview (spinner stays beside the processing label) or the
 * turn is not actively streaming (persisted feed, HITL wait).
 */
export function previewSpinnerHost(
  live: boolean,
  spinnerActive: boolean,
  current: TurnFeedItem | undefined,
): PreviewSpinnerHost | null {
  if (!live || !spinnerActive || !current) {
    return null;
  }
  return previewShowsBody(current) ? 'header' : 'pill';
}

/** Live preview header label (no ellipsis — dash form appends inbound events). */
export function previewItemLabel(item: TurnFeedItem): string {
  switch (item.kind) {
    case 'thought':
      return 'Thinking';
    case 'nudge':
      return 'nudge';
    case 'tool':
      return item.part.label.trim() ? toolPillLabel(item.part, true).verb : 'Tool';
    case 'markdown':
      return '';
  }
}

/**
 * Live preview label: the current event, then the next inbound one it anticipates. Only one
 * event is announced ahead, so a wide parallel batch never stacks a long run of names.
 */
export function previewQueueHeader(current: TurnFeedItem, inbound: readonly TurnFeedItem[]): string {
  const head = previewItemLabel(current);
  // Parallel calls of one kind share a verb; `Read — Read` says nothing new.
  let next: string | undefined;
  for (const item of inbound) {
    const label = previewItemLabel(item);
    if (label.length > 0 && label !== head) {
      next = label;
      break;
    }
  }
  return [head, next].filter((label): label is string => !!label).join(' — ');
}

/**
 * Live detail beside the preview tool pill: the most recent in-flight tool-status row in the
 * batch (path while arguments stream, write-job phase while the tool runs). Empty for
 * thought / nudge previews and for tool rows without status detail.
 */
export function previewQueueMeta(
  current: TurnFeedItem | undefined,
  inbound: readonly TurnFeedItem[],
): string {
  if (!current || current.kind !== 'tool') {
    return '';
  }
  const batch = [current, ...currentBatchInbound(current, inbound)];
  for (let i = batch.length - 1; i >= 0; i--) {
    const item = batch[i]!;
    if (item.kind !== 'tool' || !isToolTrailStatusStreamTag(item.part.streamTag)) {
      continue;
    }
    if (item.part.toolChainState !== 'running') {
      continue;
    }
    const text = item.part.text.trim();
    if (!text) {
      continue;
    }
    return toolStatusStreamPartMeta(item.part);
  }
  return '';
}

/**
 * Spinner kind for the live tool preview pill (book / terminal / globe / jot).
 * Follows the latest running tool in the batch; falls back to the current preview item.
 */
export function previewQueueToolSpinnerKind(
  current: TurnFeedItem | undefined,
  inbound: readonly TurnFeedItem[],
): ToolSpinnerKind {
  if (!current || current.kind !== 'tool') {
    return 'write';
  }
  const batch = [current, ...currentBatchInbound(current, inbound)];
  for (let i = batch.length - 1; i >= 0; i--) {
    const item = batch[i]!;
    if (item.kind !== 'tool' || item.part.toolChainState !== 'running') {
      continue;
    }
    return toolSpinnerKind(item.part.label, item.part.streamTag);
  }
  return toolSpinnerKind(current.part.label, current.part.streamTag);
}

export function clampCommittedCount(items: readonly TurnFeedItem[], committedCount: number): number {
  const max = queueableItems(items).length;
  return Math.max(0, Math.min(committedCount, max));
}

/** Skip HITL (zero-dwell) rows so they never occupy the live preview slot. */
export function advanceZeroDwell(items: readonly TurnFeedItem[], committedCount: number): number {
  const queueable = queueableItems(items);
  let n = clampCommittedCount(items, committedCount);
  while (n < queueable.length && isZeroDwellQueueItem(queueable[n]!)) {
    n += 1;
  }
  return n;
}

export function displayCommittedCount(items: readonly TurnFeedItem[], committedCount: number): number {
  return advanceZeroDwell(items, committedCount);
}

/** True when a markdown block (brief or reply) appears after the last queueable event. */
function markdownAfterLastQueueable(items: readonly TurnFeedItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'markdown') {
      return true;
    }
    if (isQueueableFeedItem(item)) {
      return false;
    }
  }
  return false;
}

/**
 * Starting committed count when a live feed mounts with items already present
 * (sidebar ↔ expanded remount, or joining a turn mid-stream).
 * Skips replaying dwell so prior cards stay chips instead of restacking into one preview.
 */
export function initialLiveCommittedCount(items: readonly TurnFeedItem[]): number {
  const queueable = queueableItems(items);
  if (queueable.length === 0) {
    return 0;
  }
  if (markdownAfterLastQueueable(items)) {
    return queueable.length;
  }
  let n = queueable.length - 1;
  const current = queueable[n];
  if (current && isToolBatchMember(current)) {
    while (n > 0 && isSameToolBatch(queueable[n - 1]!, current)) {
      n -= 1;
    }
  } else if (current?.kind === 'thought') {
    while (n > 0 && queueable[n - 1]?.kind === 'thought') {
      n -= 1;
    }
  }
  return n;
}

export function splitQueuedFeed(items: readonly TurnFeedItem[], committedCount: number): SplitQueuedFeed {
  const queueable = queueableItems(items);
  const clamped = clampCommittedCount(items, committedCount);
  const rest = queueable.slice(clamped);
  return {
    committed: queueable.slice(0, clamped),
    current: rest[0],
    inbound: rest.slice(1),
  };
}

/**
 * How many uncommitted items share the current live preview.
 * Tools batch together; thought / nudge / HITL always commit one at a time.
 */
export function previewCommitCount(items: readonly TurnFeedItem[], committedCount: number): number {
  const queueable = queueableItems(items);
  const i = clampCommittedCount(items, committedCount);
  const current = queueable[i];
  if (!current) {
    return 0;
  }
  if (!isToolBatchMember(current)) {
    return 1;
  }
  let n = 1;
  while (i + n < queueable.length && isSameToolBatch(current, queueable[i + n]!)) {
    n += 1;
  }
  return n;
}

/** Identities of the `count` items a preview commit lands as chips, starting at `committedCount`. */
export function committedItemIdentities(
  items: readonly TurnFeedItem[],
  committedCount: number,
  count: number,
): string[] {
  const start = clampCommittedCount(items, committedCount);
  return queueableItems(items).slice(start, start + count).map(queueableFeedIdentity);
}

/** Inbound events that should force the current preview to yield (not sibling tools in the same batch). */
export function pressureInbound(
  current: TurnFeedItem | undefined,
  inbound: readonly TurnFeedItem[],
): TurnFeedItem | undefined {
  if (!current) {
    return undefined;
  }
  if (!isToolBatchMember(current)) {
    return inbound[0];
  }
  return inbound.find((item) => !isSameToolBatch(current, item));
}

/**
 * How a source feed item should render while live.
 * `committedCount` should already include {@link displayCommittedCount} (HITL skipped).
 */
export function feedItemDisplayRole(
  items: readonly TurnFeedItem[],
  index: number,
  committedCount: number,
  live: boolean,
): FeedDisplayRole {
  const item = items[index];
  if (!item) {
    return 'hidden';
  }
  if (item.kind === 'markdown') {
    return 'markdown';
  }
  if (!live || !isQueueableFeedItem(item)) {
    return 'chip';
  }
  let queueableBefore = 0;
  for (let i = 0; i < index; i++) {
    if (isQueueableFeedItem(items[i]!)) {
      queueableBefore += 1;
    }
  }
  if (queueableBefore < committedCount) {
    return 'chip';
  }
  if (queueableBefore === committedCount) {
    return 'preview';
  }
  return 'hidden';
}

/**
 * {@link feedItemDisplayRole} for every item in one pass. The per-index form rescans the items
 * before it, which is quadratic over a long turn when every item asks.
 */
export function feedDisplayRoles(
  items: readonly TurnFeedItem[],
  committedCount: number,
  live: boolean,
): FeedDisplayRole[] {
  const roles: FeedDisplayRole[] = [];
  let queueableBefore = 0;
  for (const item of items) {
    const queueable = isQueueableFeedItem(item);
    if (item.kind === 'markdown') {
      roles.push('markdown');
    } else if (!live || !queueable || queueableBefore < committedCount) {
      roles.push('chip');
    } else {
      roles.push(queueableBefore === committedCount ? 'preview' : 'hidden');
    }
    if (queueable) {
      queueableBefore += 1;
    }
  }
  return roles;
}

/** True when a markdown block (brief or reply) sits after the current preview item in the source feed. */
export function markdownAfterCurrent(
  items: readonly TurnFeedItem[],
  current: TurnFeedItem | undefined,
): boolean {
  if (!current) {
    return false;
  }
  const start = items.indexOf(current);
  if (start < 0) {
    return false;
  }
  for (let i = start + 1; i < items.length; i++) {
    if (items[i]?.kind === 'markdown') {
      return true;
    }
  }
  return false;
}

/**
 * True when the current preview should yield: a non-batch inbound event, or markdown
 * (a Clara brief or the reply) has started after it. Briefs that landed *before* the
 * current preview do not count — they are already rendered in place.
 */
export function hasCommitPressure(
  items: readonly TurnFeedItem[],
  current: TurnFeedItem | undefined,
  inbound: readonly TurnFeedItem[],
): boolean {
  return pressureInbound(current, inbound) != null || markdownAfterCurrent(items, current);
}

export function decidePreviewCommit(opts: {
  live: boolean;
  items: readonly TurnFeedItem[];
  current: TurnFeedItem | undefined;
  inbound: readonly TurnFeedItem[];
  now: number;
  previewStartedAt: number;
  lastGrowthAt: number;
  inboundAppearedAt: number;
}): PreviewCommitDecision {
  if (!opts.live) {
    return { action: 'flush' };
  }
  if (!opts.current) {
    return { action: 'stay' };
  }
  if (isZeroDwellQueueItem(opts.current)) {
    return { action: 'commit' };
  }
  if (!hasCommitPressure(opts.items, opts.current, opts.inbound)) {
    return { action: 'stay' };
  }
  const dwellLeft = PREVIEW_OPEN_DWELL_MS - (opts.now - opts.previewStartedAt);
  const idleLeft = PREVIEW_IDLE_MS - (opts.now - opts.lastGrowthAt);
  const announceLeft =
    opts.inboundAppearedAt > 0 ? PREVIEW_INBOUND_ANNOUNCE_MS - (opts.now - opts.inboundAppearedAt) : 0;
  const wait = Math.max(dwellLeft, idleLeft, announceLeft);
  if (wait <= 0) {
    return { action: 'commit' };
  }
  return { action: 'wait', delayMs: wait };
}
