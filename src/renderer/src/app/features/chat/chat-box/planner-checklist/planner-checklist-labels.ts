import type { PlannerProgress } from '@shared/index';

/** The plan-mode pipeline as the panel's stage strip shows it. */
export type PlanStageKey = 'discover' | 'plan' | 'review' | 'run';
export type PlanStageState = 'done' | 'current' | 'todo' | 'failed' | 'stopped';

export interface PlanStage {
  key: PlanStageKey;
  label: string;
  state: PlanStageState;
}

const STAGES: ReadonlyArray<{ key: PlanStageKey; label: string }> = [
  { key: 'discover', label: 'Discover' },
  { key: 'plan', label: 'Plan' },
  { key: 'review', label: 'Review' },
  { key: 'run', label: 'Run' },
];

export interface PlanStatusInput {
  phase: PlannerProgress['phase'];
  planReady: boolean;
  /** The turn is still streaming (a finished turn left in a non-terminal phase was stopped). */
  live: boolean;
  questionPending: boolean;
  approvalPending: boolean;
  questionCount?: number;
  completeCount: number;
  totalSteps: number;
}

/** Stage the run is in: questions belong to Plan (the draft exists but is not final yet). */
export function planStageIndex(input: Pick<PlanStatusInput, 'phase' | 'planReady' | 'questionPending'>): number {
  switch (input.phase) {
    case 'discovery':
      return 0;
    case 'planning':
      return input.planReady && !input.questionPending ? 2 : 1;
    case 'executing':
    case 'error':
      return 3;
    case 'complete':
      return STAGES.length;
    default:
      return 0;
  }
}

/** True when a finished turn never reached a terminal phase (stopped, cancelled, or paused to clarify). */
export function planStopped(input: Pick<PlanStatusInput, 'phase' | 'live'>): boolean {
  return !input.live && input.phase !== 'complete' && input.phase !== 'error';
}

export function planStages(input: PlanStatusInput): PlanStage[] {
  const at = planStageIndex(input);
  const stopped = planStopped(input);
  return STAGES.map((s, i) => {
    let state: PlanStageState = i < at ? 'done' : i === at ? 'current' : 'todo';
    if (i === at && input.phase === 'error') state = 'failed';
    if (i === at && stopped) state = 'stopped';
    return { ...s, state };
  });
}

/** One-line "what is happening now" for the panel header. */
export function planStatusText(input: PlanStatusInput): string {
  if (planStopped(input)) {
    return 'Stopped';
  }
  if (input.questionPending) {
    const n = input.questionCount ?? 0;
    return n === 1 ? 'Answer 1 question' : n > 1 ? `Answer ${n} questions` : 'Answer the questions';
  }
  if (input.approvalPending) {
    return 'Waiting for your approval';
  }
  switch (input.phase) {
    case 'discovery':
      return 'Exploring the workspace';
    case 'planning':
      return input.planReady ? 'Ready for review' : 'Writing the plan';
    case 'executing':
      return input.totalSteps > 0 ? `Running · ${input.completeCount} of ${input.totalSteps} done` : 'Running';
    case 'complete':
      return input.totalSteps > 0 ? `Done · ${input.totalSteps} of ${input.totalSteps} steps` : 'Done';
    case 'error':
      return input.totalSteps > 0 ? `Failed · ${input.completeCount} of ${input.totalSteps} done` : 'Failed';
    default:
      return '';
  }
}
