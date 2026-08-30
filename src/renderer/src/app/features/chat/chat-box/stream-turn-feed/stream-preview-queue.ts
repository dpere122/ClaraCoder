import { isHitlTrailStreamTag, type TurnFeedItem } from '@shared/index';

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

/** Thought / brief / nudge / tool rows go through the live preview queue. Markdown does not. */
export function isQueueableFeedItem(item: TurnFeedItem): boolean {
  return item.kind === 'thought' || item.kind === 'brief' || item.kind === 'nudge' || item.kind === 'tool';
}

/** HITL trail rows skip the preview pane (dwell 0) so they still appear in arrival order. */
export function isZeroDwellQueueItem(item: TurnFeedItem): boolean {
  return item.kind === 'tool' && isHitlTrailStreamTag(item.part.streamTag);
}

/** Consecutive in-flight tools share one preview chip; HITL never joins the batch. */
export function isToolBatchMember(item: TurnFeedItem): boolean {
  return item.kind === 'tool' && !isZeroDwellQueueItem(item);
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
  return item?.kind === 'thought' || item?.kind === 'brief' || item?.kind === 'nudge';
}

/** Live preview header label (no ellipsis — dash form appends inbound events). */
export function previewItemLabel(item: TurnFeedItem): string {
  switch (item.kind) {
    case 'thought':
      return 'Thinking';
    case 'brief':
      return 'reasoning';
    case 'nudge':
      return 'nudge';
    case 'tool':
      return item.part.label.trim() || 'Tool';
    case 'markdown':
      return '';
  }
}

export function previewQueueHeader(current: TurnFeedItem, inbound: readonly TurnFeedItem[]): string {
  const labels = [previewItemLabel(current), ...inbound.map(previewItemLabel)].filter((label) => label.length > 0);
  return labels.join(' — ');
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
  if (items.some((item) => item.kind === 'markdown')) {
    return queueable.length;
  }
  let n = queueable.length - 1;
  const current = queueable[n];
  if (current && isToolBatchMember(current)) {
    while (n > 0 && isToolBatchMember(queueable[n - 1]!)) {
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
 * How many uncommitted tools share the current live preview chip.
 * Thought / brief / nudge / HITL always commit one at a time.
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
  while (i + n < queueable.length && isToolBatchMember(queueable[i + n]!)) {
    n += 1;
  }
  return n;
}

/** Inbound events that should force the current preview to yield (not sibling tools in the same batch). */
export function pressureInbound(
  current: TurnFeedItem | undefined,
  inbound: readonly TurnFeedItem[],
): TurnFeedItem | undefined {
  if (!current || !isToolBatchMember(current)) {
    return inbound[0];
  }
  return inbound.find((item) => !isToolBatchMember(item));
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

/** True when the current preview should yield (non-batch inbound or the reply markdown has started). */
export function hasCommitPressure(
  items: readonly TurnFeedItem[],
  current: TurnFeedItem | undefined,
  inbound: readonly TurnFeedItem[],
): boolean {
  return pressureInbound(current, inbound) != null || items.some((item) => item.kind === 'markdown');
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
