import {
  activityHeadline,
  formatThoughtDuration,
  isHitlTrailStreamTag,
  isStoppedToolCall,
  plural,
  toolOutcomeNotes,
  toolPillLabel,
  type StreamPart,
  type ToolPillLabel,
  type TurnFeedItem,
} from '@shared/index';
import { auxStreamToolPartPillState } from '../aux-stream-tool-part/aux-stream-tool-part';
import type { FeedDisplayRole } from './stream-preview-queue';

/** How a stretch of work renders: one activity block per stretch, in execution order. */
export interface ActivityLayout {
  /** Lead item index (first of the stretch) → every member index, in order. */
  blocks: ReadonlyMap<number, readonly number[]>;
  /** Members after the lead: they render inside their block, not at top level. */
  hidden: ReadonlySet<number>;
  /** Leads of stretches still being worked on (live turn, no prose after them yet). */
  working: ReadonlySet<number>;
}

/** Pill text for one activity block: `Read 3 files, edited a.py · 1 failed · 42s`. */
export interface ActivitySummary {
  /** What the stretch did, in order (`Read 3 files, edited a.py`); `Thought` for thinking alone; '' when nothing landed. */
  headline: string;
  /** `1 failed · 1 stopped`, or ''. */
  outcomes: string;
  /** Hover text: every action (the headline may drop some), then the tally. */
  title: string;
  duration: string;
  failed: boolean;
}

const EMPTY_LAYOUT: ActivityLayout = { blocks: new Map(), hidden: new Set(), working: new Set() };

/** Thoughts, nudges and tool rows (chip, live preview or queued) join activity blocks; HITL rows stay in the open. */
function isActivityItem(item: TurnFeedItem, role: FeedDisplayRole): boolean {
  if (role === 'markdown') {
    return false;
  }
  if (item.kind === 'thought' || item.kind === 'nudge') {
    return true;
  }
  return item.kind === 'tool' && !isHitlTrailStreamTag(item.part.streamTag);
}

/**
 * Wrap each stretch of work (thoughts, nudges and tool rows with no prose or HITL row between
 * them) in one activity block from its first row on, so pills land inside the block instead of
 * being folded into it later. The live preview and queued rows belong to the stretch they
 * arrive in. A stretch is still working until prose follows it or the turn is no longer live.
 * A stretch with nothing on screen yet (only queued rows, or rows folded into another pill)
 * gets no block until something in it shows.
 */
export function activityLayout(
  items: readonly TurnFeedItem[],
  roleOf: (index: number) => FeedDisplayRole,
  live: boolean,
  chipHidden: ReadonlySet<number>,
): ActivityLayout {
  const blocks = new Map<number, number[]>();
  const hidden = new Set<number>();
  const working = new Set<number>();
  let lastMarkdown = -1;
  items.forEach((item, index) => {
    if (item.kind === 'markdown') {
      lastMarkdown = index;
    }
  });
  let run: number[] = [];

  const close = (): void => {
    const shown = run.some((index) => {
      const role = roleOf(index);
      return role === 'preview' || (role === 'chip' && !chipHidden.has(index));
    });
    if (shown) {
      const lead = run[0]!;
      blocks.set(lead, run);
      for (const index of run.slice(1)) {
        hidden.add(index);
      }
      if (live && lastMarkdown < run[run.length - 1]!) {
        working.add(lead);
      }
    }
    run = [];
  };

  items.forEach((item, index) => {
    if (isActivityItem(item, roleOf(index))) {
      run.push(index);
    } else if (run.length > 0) {
      close();
    }
  });
  if (run.length > 0) {
    close();
  }
  return blocks.size > 0 ? { blocks, hidden, working } : EMPTY_LAYOUT;
}

/**
 * Activity pill text. The headline names what the model did between prose, from its tool calls
 * in order. Time is thinking plus tool run time; parallel calls from one LLM step overlap, so
 * each step counts its slowest call. `merged` rows (run_command status rows whose output lane is
 * also in the feed) are duplicates and are not counted.
 */
export function activitySummary(
  items: readonly TurnFeedItem[],
  members: readonly number[],
  merged: ReadonlySet<number>,
): ActivitySummary {
  let thoughts = 0;
  let nudges = 0;
  let tools = 0;
  let failed = 0;
  let stopped = 0;
  let thinkingMs = 0;
  const unbatchedMs: number[] = [];
  const slowestByBatch = new Map<string, number>();
  const labels: ToolPillLabel[] = [];
  const unsettled: boolean[] = [];

  for (const index of members) {
    const item = items[index];
    if (!item || item.kind === 'markdown') {
      continue;
    }
    if (item.kind === 'thought') {
      thoughts += 1;
      thinkingMs += item.part.thoughtDurationMs ?? 0;
      continue;
    }
    if (item.kind === 'nudge') {
      nudges += 1;
      continue;
    }
    if (merged.has(index)) {
      continue;
    }
    tools += 1;
    const part: StreamPart = item.part;
    labels.push(toolPillLabel(part));
    const isFailed = auxStreamToolPartPillState(part, false) === 'error';
    const isStopped = isStoppedToolCall(part);
    unsettled.push(isFailed || isStopped);
    if (isFailed) {
      failed += 1;
    }
    if (isStopped) {
      stopped += 1;
    }
    const ms = part.toolDurationMs;
    if (ms === undefined) {
      continue;
    }
    if (part.toolBatch) {
      slowestByBatch.set(part.toolBatch, Math.max(slowestByBatch.get(part.toolBatch) ?? 0, ms));
    } else {
      unbatchedMs.push(ms);
    }
  }

  const counts = [
    thoughts > 0 ? plural(thoughts, 'thought') : '',
    nudges > 0 ? plural(nudges, 'nudge') : '',
    tools > 0 ? plural(tools, 'tool') : '',
  ].filter(Boolean);
  const toolMs = [...slowestByBatch.values(), ...unbatchedMs].reduce((sum, ms) => sum + ms, 0);
  const totalMs = thinkingMs + toolMs;
  const actions = activityHeadline(labels, unsettled);
  return {
    headline: actions.text || (thoughts + nudges > 0 ? 'Thought' : ''),
    outcomes: toolOutcomeNotes(failed, stopped).join(' · '),
    title: [...actions.clauses.map((c) => c.charAt(0).toUpperCase() + c.slice(1)), counts.join(', ')]
      .filter(Boolean)
      .join('\n'),
    duration: totalMs > 0 ? formatThoughtDuration(totalMs) : '',
    failed: failed > 0,
  };
}
