import { describe, expect, it } from 'vitest';
import { planStageIndex, planStages, planStatusText, type PlanStatusInput } from './planner-checklist-labels';

const base: PlanStatusInput = {
  phase: 'discovery',
  planReady: false,
  live: true,
  questionPending: false,
  approvalPending: false,
  completeCount: 0,
  totalSteps: 0,
};

describe('planStageIndex', () => {
  it('walks discover → plan → review → run', () => {
    expect(planStageIndex({ ...base, phase: 'discovery' })).toBe(0);
    expect(planStageIndex({ ...base, phase: 'planning', planReady: false })).toBe(1);
    expect(planStageIndex({ ...base, phase: 'planning', planReady: true })).toBe(2);
    expect(planStageIndex({ ...base, phase: 'executing' })).toBe(3);
    expect(planStageIndex({ ...base, phase: 'complete' })).toBe(4);
  });

  it('keeps clarifying questions in the Plan stage', () => {
    expect(planStageIndex({ ...base, phase: 'planning', planReady: true, questionPending: true })).toBe(1);
  });
});

describe('planStages', () => {
  it('marks earlier stages done and the active one current', () => {
    const states = planStages({ ...base, phase: 'planning', planReady: true }).map((s) => s.state);
    expect(states).toEqual(['done', 'done', 'current', 'todo']);
  });

  it('marks every stage done once complete', () => {
    expect(planStages({ ...base, phase: 'complete' }).every((s) => s.state === 'done')).toBe(true);
  });

  it('marks the run stage failed on error', () => {
    expect(planStages({ ...base, phase: 'error' })[3].state).toBe('failed');
  });

  it('marks the active stage stopped when a finished turn never reached a terminal phase', () => {
    expect(planStages({ ...base, phase: 'planning', planReady: true, live: false })[2].state).toBe('stopped');
  });
});

describe('planStatusText', () => {
  it('describes each phase', () => {
    expect(planStatusText(base)).toBe('Exploring the workspace');
    expect(planStatusText({ ...base, phase: 'planning' })).toBe('Writing the plan');
    expect(planStatusText({ ...base, phase: 'executing', completeCount: 2, totalSteps: 5 })).toBe('Running · 2 of 5 done');
    expect(planStatusText({ ...base, phase: 'complete', totalSteps: 5 })).toBe('Done · 5 of 5 steps');
  });

  it('puts pending decisions first', () => {
    expect(planStatusText({ ...base, phase: 'planning', planReady: true, questionPending: true, questionCount: 3 })).toBe(
      'Answer 3 questions',
    );
    expect(planStatusText({ ...base, phase: 'planning', planReady: true, approvalPending: true })).toBe(
      'Waiting for your approval',
    );
  });

  it('reports a stopped plan on a finished turn', () => {
    expect(planStatusText({ ...base, phase: 'planning', live: false })).toBe('Stopped');
  });
});
