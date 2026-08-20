import { describe, expect, it } from 'vitest';
import { frameDisplayLabel, phaseDisplayLabel } from './planner-checklist-labels';

describe('phaseDisplayLabel', () => {
  it('shows writing while the plan is still streaming', () => {
    expect(phaseDisplayLabel('planning', false)).toBe('Writing plan');
  });

  it('shows ready once the plan can be reviewed', () => {
    expect(phaseDisplayLabel('planning', true)).toBe('Ready for review');
    expect(phaseDisplayLabel('planning')).toBe('Ready for review');
  });
});

describe('frameDisplayLabel', () => {
  it('uses WRITE while the plan is streaming', () => {
    expect(frameDisplayLabel('planning', false, false)).toBe('PLAN · WRITE');
  });

  it('uses REVIEW when awaiting approval or the plan is ready', () => {
    expect(frameDisplayLabel('planning', true, false)).toBe('PLAN · REVIEW');
    expect(frameDisplayLabel('planning', false, true)).toBe('PLAN · REVIEW');
  });
});
