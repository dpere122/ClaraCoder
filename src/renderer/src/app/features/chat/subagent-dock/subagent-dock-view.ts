import type { StreamPart } from '@shared/index';
import {
  condenseToolTrailText,
  formatToolDuration,
  isInFlightToolPart,
  isToolTrailStatusStreamTag,
  primaryAssistantTextFromParts,
  toolPillLabel,
  toolPillMeta,
} from '@shared/index';
import type { SubagentRun } from '../../shell/conversation-session.service';

export type SubagentCardState = 'working' | 'review' | 'done' | 'stopped' | 'failed';

/** What one sub-agent card in the dock shows. */
export interface SubagentCardView {
  conversationId: string;
  name: string;
  /** The task, flattened to one line (the full text is the tooltip). */
  task: string;
  taskFull: string;
  state: SubagentCardState;
  stateLabel: string;
  /** `12s`, `1m 05s`: since it started, frozen when it ended. */
  elapsed: string;
  /** Still running (Stop applies). */
  live: boolean;
  /** The main agent kept working instead of waiting for this one. */
  background: boolean;
  /** The call it is making now (`Read · src/app.ts`), or its last one once it finished. */
  activity: string;
  /** Last lines of its reply so far. */
  textTail: string;
}

const STATE_LABELS: Readonly<Record<SubagentCardState, string>> = {
  working: 'Working',
  review: 'Needs approval',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};

const TEXT_TAIL_LINES = 2;
const TEXT_TAIL_MAX_CHARS = 180;

function cardState(run: SubagentRun, awaitingApproval: boolean): SubagentCardState {
  switch (run.outcome) {
    case 'completed':
      return 'done';
    case 'aborted':
      return 'stopped';
    case 'error':
      return 'failed';
    default:
      return awaitingApproval ? 'review' : 'working';
  }
}

/** `Read · src/app.ts`: the in-flight tool call, else the most recent one. */
function activityLine(parts: readonly StreamPart[], live: boolean): string {
  let latest: StreamPart | undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (isInFlightToolPart(part)) {
      latest = part;
      break;
    }
    if (!latest && isToolTrailStatusStreamTag(part.streamTag)) {
      latest = part;
    }
  }
  if (!latest) {
    return '';
  }
  const label = toolPillLabel(latest, live);
  const meta = toolPillMeta(label);
  return condenseToolTrailText(meta ? `${label.verb} · ${meta}` : label.verb, 96);
}

/** The last non-empty lines of the reply text, capped. */
function textTail(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-TEXT_TAIL_LINES).join(' ');
  return tail.length > TEXT_TAIL_MAX_CHARS ? `…${tail.slice(tail.length - TEXT_TAIL_MAX_CHARS + 1).trimStart()}` : tail;
}

/**
 * Card view-models for the sub-agent dock.
 *
 * @param partsFor live stream parts of a sub-agent's turn (empty once its reply is saved)
 * @param finalTextFor the clean final text the backend sent for it, if any
 * @param approvals sub-agent id -> its approval cards waiting in the parent's dock
 */
export function buildSubagentCardViews(
  runs: readonly SubagentRun[],
  partsFor: (conversationId: string) => readonly StreamPart[],
  finalTextFor: (conversationId: string) => string | undefined,
  approvals: ReadonlyMap<string, readonly string[]>,
  nowMs: number,
): SubagentCardView[] {
  return runs.map((run) => {
    const live = run.outcome === undefined;
    const state = cardState(run, (approvals.get(run.conversationId)?.length ?? 0) > 0);
    const parts = partsFor(run.conversationId);
    const text = finalTextFor(run.conversationId) || primaryAssistantTextFromParts([...parts]);
    const end = run.endedAt ?? nowMs;
    return {
      conversationId: run.conversationId,
      name: run.name,
      task: condenseToolTrailText(run.task, 140),
      taskFull: run.task,
      state,
      stateLabel: STATE_LABELS[state],
      elapsed: formatToolDuration(Math.max(0, end - run.startedAt)),
      live,
      background: !!run.background,
      activity: activityLine(parts, live),
      textTail: textTail(text),
    };
  });
}
