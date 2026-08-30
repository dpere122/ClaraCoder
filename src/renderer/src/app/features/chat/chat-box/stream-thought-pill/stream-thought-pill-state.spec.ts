import { describe, expect, it } from 'vitest';
import {
  isThoughtStreamingPreview,
  resolveThoughtPillExpanded,
  thoughtPillLabel,
  thoughtPillState,
} from './stream-thought-pill-state';

describe('thoughtPillLabel', () => {
  it('uses Thinking while the live thought is active', () => {
    expect(thoughtPillLabel(true, true)).toBe('Thinking…');
    expect(thoughtPillLabel(true, false)).toBe('Thought');
    expect(thoughtPillLabel(false, true)).toBe('Thought');
  });
});

describe('thoughtPillState', () => {
  it('is running only for the active live thought', () => {
    expect(thoughtPillState(true, true)).toBe('running');
    expect(thoughtPillState(true, false)).toBe('complete');
    expect(thoughtPillState(false, false)).toBe('complete');
  });
});

describe('resolveThoughtPillExpanded', () => {
  it('auto-expands the active live thought and auto-collapses when superseded', () => {
    expect(resolveThoughtPillExpanded(true, true, null)).toBe(true);
    expect(resolveThoughtPillExpanded(true, false, null)).toBe(false);
    expect(resolveThoughtPillExpanded(false, false, null)).toBe(false);
  });

  it('honors a user expand/collapse override', () => {
    expect(resolveThoughtPillExpanded(true, false, true)).toBe(true);
    expect(resolveThoughtPillExpanded(true, true, false)).toBe(false);
  });
});

describe('isThoughtStreamingPreview', () => {
  it('shows the preview while the live thought is active', () => {
    expect(isThoughtStreamingPreview(true, true, null)).toBe(true);
  });

  it('hides the preview when the thought is superseded or persisted', () => {
    expect(isThoughtStreamingPreview(true, false, null)).toBe(false);
    expect(isThoughtStreamingPreview(false, true, null)).toBe(false);
    expect(isThoughtStreamingPreview(false, false, null)).toBe(false);
  });

  it('stays a chip for a committed live thought even while later tools exist in the source feed', () => {
    expect(isThoughtStreamingPreview(true, false, null)).toBe(false);
  });

  it('hides the preview when the user collapses it', () => {
    expect(isThoughtStreamingPreview(true, true, false)).toBe(false);
  });

  it('keeps the preview when the user re-expands while still live', () => {
    expect(isThoughtStreamingPreview(true, true, true)).toBe(true);
  });
});
