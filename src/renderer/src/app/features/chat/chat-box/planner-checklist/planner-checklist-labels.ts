import type { PlannerProgress } from '@shared/index';

export function phaseDisplayLabel(phase: PlannerProgress['phase'], planReady = true): string {
  switch (phase) {
    case 'planning':
      return planReady ? 'Ready for review' : 'Writing plan';
    case 'executing':
      return 'Running';
    case 'complete':
      return 'Complete';
    case 'error':
      return 'Failed';
    case 'discovery':
      return 'Discovering';
    default:
      return phase;
  }
}

export function frameDisplayLabel(
  phase: PlannerProgress['phase'],
  awaitingApproval: boolean,
  planReady = true,
): string {
  if (awaitingApproval) return 'PLAN · REVIEW';
  switch (phase) {
    case 'discovery':
      return 'PLAN · DISCOVER';
    case 'planning':
      return planReady ? 'PLAN · REVIEW' : 'PLAN · WRITE';
    case 'executing':
      return 'PLAN · RUN';
    case 'complete':
      return 'PLAN · DONE';
    case 'error':
      return 'PLAN · FAIL';
    default:
      return 'PLAN';
  }
}
