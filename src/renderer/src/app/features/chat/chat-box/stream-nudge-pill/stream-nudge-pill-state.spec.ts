import { describe, expect, it } from 'vitest';
import {
  isNudgeStreamingPreview,
  nudgePillLabel,
  nudgePillState,
  resolveNudgePillExpanded,
} from './stream-nudge-pill-state';

describe('nudgePillLabel', () => {
  it('always labels the premature reply as nudge', () => {
    expect(nudgePillLabel(true, true)).toBe('nudge');
    expect(nudgePillLabel(true, false)).toBe('nudge');
    expect(nudgePillLabel(false, true)).toBe('nudge');
  });
});

describe('nudgePillState', () => {
  it('is running only for the active live nudge', () => {
    expect(nudgePillState(true, true)).toBe('running');
    expect(nudgePillState(true, false)).toBe('complete');
    expect(nudgePillState(false, false)).toBe('complete');
  });
});

describe('resolveNudgePillExpanded', () => {
  it('auto-expands the active live nudge and auto-collapses when superseded', () => {
    expect(resolveNudgePillExpanded(true, true, null)).toBe(true);
    expect(resolveNudgePillExpanded(true, false, null)).toBe(false);
    expect(resolveNudgePillExpanded(false, false, null)).toBe(false);
  });

  it('honors a user expand/collapse override', () => {
    expect(resolveNudgePillExpanded(true, false, true)).toBe(true);
    expect(resolveNudgePillExpanded(true, true, false)).toBe(false);
  });
});

describe('isNudgeStreamingPreview', () => {
  it('stays in preview while the live nudge is generating', () => {
    expect(isNudgeStreamingPreview(true, true, null)).toBe(true);
  });

  it('hides the preview when the nudge is superseded or persisted', () => {
    expect(isNudgeStreamingPreview(true, false, null)).toBe(false);
    expect(isNudgeStreamingPreview(false, true, null)).toBe(false);
    expect(isNudgeStreamingPreview(false, false, null)).toBe(false);
  });

  it('hides the preview when the user collapses it', () => {
    expect(isNudgeStreamingPreview(true, true, false)).toBe(false);
  });

  it('keeps the preview when the user re-expands while still live', () => {
    expect(isNudgeStreamingPreview(true, true, true)).toBe(true);
  });
});
