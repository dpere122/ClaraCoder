import { describe, expect, it } from 'vitest';
import {
  briefPillLabel,
  briefPillState,
  isBriefStreamingPreview,
  resolveBriefPillExpanded,
} from './stream-brief-pill-state';

describe('briefPillLabel', () => {
  it('always labels the Clara brief as reasoning', () => {
    expect(briefPillLabel(true, true)).toBe('reasoning');
    expect(briefPillLabel(true, false)).toBe('reasoning');
    expect(briefPillLabel(false, true)).toBe('reasoning');
  });
});

describe('briefPillState', () => {
  it('is running only for the active live brief', () => {
    expect(briefPillState(true, true)).toBe('running');
    expect(briefPillState(true, false)).toBe('complete');
    expect(briefPillState(false, false)).toBe('complete');
  });
});

describe('resolveBriefPillExpanded', () => {
  it('auto-expands the active live brief and auto-collapses when superseded', () => {
    expect(resolveBriefPillExpanded(true, true, null)).toBe(true);
    expect(resolveBriefPillExpanded(true, false, null)).toBe(false);
    expect(resolveBriefPillExpanded(false, false, null)).toBe(false);
  });

  it('honors a user expand/collapse override', () => {
    expect(resolveBriefPillExpanded(true, false, true)).toBe(true);
    expect(resolveBriefPillExpanded(true, true, false)).toBe(false);
  });
});

describe('isBriefStreamingPreview', () => {
  it('stays in preview while the live brief is generating even if a later thought is active', () => {
    expect(isBriefStreamingPreview(true, true, null)).toBe(true);
  });

  it('hides the preview when the brief is superseded or persisted', () => {
    expect(isBriefStreamingPreview(true, false, null)).toBe(false);
    expect(isBriefStreamingPreview(false, true, null)).toBe(false);
    expect(isBriefStreamingPreview(false, false, null)).toBe(false);
  });

  it('hides the preview when the user collapses it', () => {
    expect(isBriefStreamingPreview(true, true, false)).toBe(false);
  });

  it('keeps the preview when the user re-expands while still live', () => {
    expect(isBriefStreamingPreview(true, true, true)).toBe(true);
  });
});
