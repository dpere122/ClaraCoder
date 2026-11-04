import {
  isDeclinedToolCall,
  isHitlTrailStreamTag,
  isQuietCommandLane,
  runCommandIdFromReport,
  runCommandLaneId,
  toolPillLabel,
  toolPillsGroupTogether,
  type StreamPart,
  type ToolPillLabel,
  type TurnFeedItem,
} from '@shared/index';
import type { FeedDisplayRole } from './stream-preview-queue';

/** How tool chips render: grouped runs, and rows folded into another row. */
export interface ToolChipLayout {
  /** Lead item index → every member index of its group (2+ consecutive same-kind chips). */
  groups: ReadonlyMap<number, readonly number[]>;
  /** Indices that render nothing at top level (group members after the lead, merged rows, quiet lanes). */
  hidden: ReadonlySet<number>;
  /** `run_command` status rows duplicated by their output lane (see {@link runCommandLanesByStatusIndex}). */
  merged: ReadonlySet<number>;
  /** Finished output lanes (by index) with the run time and step of the status row they stand in for. */
  timedLanes: ReadonlyMap<number, StreamPart>;
}

const EMPTY_LAYOUT: ToolChipLayout = { groups: new Map(), hidden: new Set(), merged: new Set(), timedLanes: new Map() };

/**
 * `run_command` status rows whose `run-command:<id>` output lane is also in the feed → that lane's
 * index. The lane already shows the command and its exit code, so the status row is a duplicate
 * pill. A row whose text still holds the approval prompt (no command id yet) pairs with the next
 * lane. A lane that finished without printing pairs with nothing: its status row has the result.
 */
function runCommandLanesByStatusIndex(items: readonly TurnFeedItem[]): Map<number, number> {
  const merged = new Map<number, number>();
  const open: { index: number; id: string | null }[] = [];
  items.forEach((item, index) => {
    if (item.kind !== 'tool') {
      return;
    }
    if (item.part.label.trim() === 'run_command' && !runCommandLaneId(item.part.streamTag)) {
      const id = runCommandIdFromReport(item.part.text);
      // A call that failed or was declined without a command id never got a lane; pairing it with
      // a later lane would hide it.
      const laneless =
        item.part.toolChainState === 'error' || /^Tool error:/.test(item.part.text.trim()) || isDeclinedToolCall(item.part);
      if (id !== null || !laneless) {
        open.push({ index, id });
      }
      return;
    }
    const laneId = runCommandLaneId(item.part.streamTag);
    if (!laneId || isQuietCommandLane(item.part)) {
      return;
    }
    let match = -1;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i]!.id === laneId) {
        match = i;
        break;
      }
    }
    if (match < 0) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i]!.id === null) {
          match = i;
          break;
        }
      }
    }
    if (match >= 0) {
      merged.set(open[match]!.index, index);
      open.splice(match, 1);
    }
  });
  return merged;
}

/**
 * Collapse back-to-back tool chips of one kind (`Read`, `Read`, `Read`, or mixed lookups like
 * `Read`, `Search`, `List` → `Explore`) into a single group pill, in call order. Any non-chip
 * item between them (thought, prose, HITL row, live preview) ends the run; merged `run_command`
 * status rows and lanes that finished without printing are skipped without breaking it.
 */
export function toolChipLayout(
  items: readonly TurnFeedItem[],
  roleOf: (index: number) => FeedDisplayRole,
  live = false,
): ToolChipLayout {
  if (!items.some((item) => item.kind === 'tool')) {
    return EMPTY_LAYOUT;
  }
  const lanes = runCommandLanesByStatusIndex(items);
  const merged = new Set(lanes.keys());
  const hidden = new Set<number>();
  const groups = new Map<number, number[]>();
  for (const index of merged) {
    if (roleOf(index) === 'chip') {
      hidden.add(index);
    }
  }

  let run: number[] = [];
  let runLabel: ToolPillLabel | null = null;
  const flush = (): void => {
    if (run.length >= 2) {
      groups.set(run[0]!, run);
      for (const index of run.slice(1)) {
        hidden.add(index);
      }
    }
    run = [];
    runLabel = null;
  };

  items.forEach((item, index) => {
    if (hidden.has(index)) {
      return;
    }
    if (item.kind === 'tool' && isQuietCommandLane(item.part) && roleOf(index) === 'chip') {
      hidden.add(index);
      return;
    }
    if (item.kind !== 'tool' || isHitlTrailStreamTag(item.part.streamTag) || roleOf(index) !== 'chip') {
      flush();
      return;
    }
    const label = toolPillLabel(item.part, live);
    if (runLabel && !toolPillsGroupTogether(runLabel, label)) {
      flush();
    }
    run.push(index);
    runLabel ??= label;
  });
  flush();
  return { groups, hidden, merged, timedLanes: timedRunCommandLanes(items, lanes) };
}

/**
 * Only the status row knows how long a command ran, and it is the row that stays hidden. A lane
 * still running has no time yet: its status row may only have waited for the first output. Nor has
 * one whose report says `still running`: that call timed the wait, and the command ran on after it.
 */
function timedRunCommandLanes(items: readonly TurnFeedItem[], lanes: ReadonlyMap<number, number>): Map<number, StreamPart> {
  const timed = new Map<number, StreamPart>();
  for (const [statusIndex, laneIndex] of lanes) {
    const status = items[statusIndex];
    const lane = items[laneIndex];
    if (
      status?.kind === 'tool'
      && lane?.kind === 'tool'
      && lane.part.runComplete
      && status.part.toolDurationMs !== undefined
      && !/Status: still running/.test(status.part.text)
    ) {
      timed.set(laneIndex, timedLaneCopy(lane.part, status.part));
    }
  }
  return timed;
}

/** Timed copies by lane: the layout reruns on every streamed token, and finished rows should not. */
const timedLaneCopies = new WeakMap<StreamPart, StreamPart>();

function timedLaneCopy(lane: StreamPart, status: StreamPart): StreamPart {
  const toolBatch = status.toolBatch || lane.toolBatch;
  const cached = timedLaneCopies.get(lane);
  if (cached && cached.toolDurationMs === status.toolDurationMs && cached.toolBatch === toolBatch) {
    return cached;
  }
  const timed: StreamPart = { ...lane, toolDurationMs: status.toolDurationMs, ...(toolBatch ? { toolBatch } : {}) };
  timedLaneCopies.set(lane, timed);
  return timed;
}

/**
 * Top-level item indices that play the settle animation: chips whose item just left the live
 * preview (`settling` holds their feed indices), and the group pill that took any of them in.
 */
export function settlingChipIndices(
  settling: ReadonlySet<number>,
  groups: ReadonlyMap<number, readonly number[]>,
): Set<number> {
  const out = new Set(settling);
  if (out.size === 0) {
    return out;
  }
  for (const [lead, members] of groups) {
    if (members.some((index) => out.has(index))) {
      out.add(lead);
    }
  }
  return out;
}

/** Parts for a group's member indices, with any lane's run time from `timedLanes`. */
export function toolChipGroupParts(
  items: readonly TurnFeedItem[],
  indices: readonly number[],
  timedLanes: ReadonlyMap<number, StreamPart> = EMPTY_LAYOUT.timedLanes,
): StreamPart[] {
  const parts: StreamPart[] = [];
  for (const index of indices) {
    const item = items[index];
    if (item?.kind === 'tool') {
      parts.push(timedLanes.get(index) ?? item.part);
    }
  }
  return parts;
}
