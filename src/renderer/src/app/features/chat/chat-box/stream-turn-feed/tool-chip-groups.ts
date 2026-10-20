import {
  isHitlTrailStreamTag,
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
  /** Indices that render nothing at top level (group members after the lead, merged rows). */
  hidden: ReadonlySet<number>;
}

const EMPTY_LAYOUT: ToolChipLayout = { groups: new Map(), hidden: new Set() };

/**
 * `run_command` status rows whose `run-command:<id>` output lane is also in the feed. The lane
 * already shows the command and its exit code, so the status row is a duplicate pill. A row
 * whose text still holds the approval prompt (no command id yet) pairs with the next lane.
 */
export function mergedRunCommandStatusIndices(items: readonly TurnFeedItem[]): Set<number> {
  const merged = new Set<number>();
  const open: { index: number; id: string | null }[] = [];
  items.forEach((item, index) => {
    if (item.kind !== 'tool') {
      return;
    }
    if (item.part.label.trim() === 'run_command' && !runCommandLaneId(item.part.streamTag)) {
      const id = runCommandIdFromReport(item.part.text);
      // A call that failed without a command id never got a lane; pairing it with a later
      // lane would hide the failure.
      const failed = item.part.toolChainState === 'error' || /^Tool error:/.test(item.part.text.trim());
      if (id !== null || !failed) {
        open.push({ index, id });
      }
      return;
    }
    const laneId = runCommandLaneId(item.part.streamTag);
    if (!laneId) {
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
      merged.add(open[match]!.index);
      open.splice(match, 1);
    }
  });
  return merged;
}

/**
 * Collapse back-to-back tool chips of one kind (`Read`, `Read`, `Read`) into a single group
 * pill. Any non-chip item between them (thought, prose, HITL row, live preview) ends the run;
 * merged `run_command` status rows are skipped without breaking it.
 */
export function toolChipLayout(
  items: readonly TurnFeedItem[],
  roleOf: (index: number) => FeedDisplayRole,
  live = false,
): ToolChipLayout {
  if (!items.some((item) => item.kind === 'tool')) {
    return EMPTY_LAYOUT;
  }
  const merged = mergedRunCommandStatusIndices(items);
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
  return { groups, hidden };
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

/** Parts for a group's member indices. */
export function toolChipGroupParts(items: readonly TurnFeedItem[], indices: readonly number[]): StreamPart[] {
  const parts: StreamPart[] = [];
  for (const index of indices) {
    const item = items[index];
    if (item?.kind === 'tool') {
      parts.push(item.part);
    }
  }
  return parts;
}
