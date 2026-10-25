import type { PlannerProgress } from '@shared/index';
import { describe, expect, it } from 'vitest';
import { hitlDockArtifactsBesidePlan, livePlanDockContext, type ChatMessage } from './chat-box-display';

const planner: PlannerProgress = {
  streamTag: 'planner',
  phase: 'planning',
  planReady: true,
  steps: [{ id: 'step-1', text: 'Do it', state: 'pending' }],
};

const liveTurn: ChatMessage[] = [
  { role: 'user', text: 'Plan it' },
  {
    role: 'agent_question',
    payload: {
      version: 1,
      requestId: 'q1',
      title: 'Clarify',
      message: '',
      submitLabel: 'Submit',
      cancelLabel: 'Cancel',
      questions: [{ id: 'q-1', prompt: 'REST or gRPC?', options: [], allowOther: true }],
    },
    reviewStatus: 'pending',
  },
];

describe('livePlanDockContext', () => {
  it('docks the live plan with its question card', () => {
    const ctx = livePlanDockContext(liveTurn, planner, true);
    expect(ctx?.planner.phase).toBe('planning');
    expect(ctx?.agentQuestion?.requestId).toBe('q1');
  });

  it('shows nothing once the turn has finished', () => {
    expect(livePlanDockContext(liveTurn, planner, false)).toBeNull();
  });

  it('shows nothing for a live turn without a plan', () => {
    expect(livePlanDockContext([{ role: 'user', text: 'Hi' }], null, true)).toBeNull();
  });
});

describe('hitlDockArtifactsBesidePlan', () => {
  const cards = [{ role: 'accept_command' }, { role: 'plan_confirm' }, { role: 'agent_question' }];

  it('leaves plan question and approval to the plan dock', () => {
    expect(hitlDockArtifactsBesidePlan(cards, true).map((a) => a.role)).toEqual(['accept_command']);
  });

  it('keeps them in the review dock when no plan dock shows', () => {
    expect(hitlDockArtifactsBesidePlan(cards, false)).toHaveLength(3);
  });
});
