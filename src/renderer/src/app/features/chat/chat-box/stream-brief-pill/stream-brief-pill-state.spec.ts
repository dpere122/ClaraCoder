import { describe, expect, it } from 'vitest';
import {
  BRIEF_INLINE_LINE_LIMIT,
  BRIEF_WRAP_CHARS,
  briefLineCount,
  briefPillLabel,
  briefPillState,
  isBriefStreamingPreview,
  isShortBrief,
  resolveBriefPillExpanded,
  shouldKeepBriefRendered,
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

describe('briefLineCount', () => {
  it('counts explicit newlines', () => {
    expect(briefLineCount('')).toBe(0);
    expect(briefLineCount('   ')).toBe(0);
    expect(briefLineCount('one line')).toBe(1);
    expect(briefLineCount('one\ntwo')).toBe(2);
    expect(briefLineCount('one\ntwo\nthree')).toBe(3);
  });

  it('counts a long wrapping row as multiple lines', () => {
    expect(briefLineCount('a'.repeat(BRIEF_WRAP_CHARS))).toBe(1);
    expect(briefLineCount('a'.repeat(BRIEF_WRAP_CHARS + 1))).toBe(2);
    expect(briefLineCount('a'.repeat(BRIEF_WRAP_CHARS * 2 + 1))).toBe(3);
  });
});

describe('isShortBrief', () => {
  it('keeps one- through three-line briefs inline', () => {
    expect(isShortBrief('Checking the layout next.')).toBe(true);
    expect(isShortBrief('First sentence.\nSecond sentence.')).toBe(true);
    expect(isShortBrief('one\ntwo\nthree')).toBe(true);
  });

  it('condenses briefs that reach the line limit', () => {
    expect(isShortBrief('one\ntwo\nthree\nfour')).toBe(false);
    expect(BRIEF_INLINE_LINE_LIMIT).toBe(4);
  });
});

describe('shouldKeepBriefRendered', () => {
  it('keeps short briefs rendered unless the user collapsed them', () => {
    expect(shouldKeepBriefRendered('Checking files.', null)).toBe(true);
    expect(shouldKeepBriefRendered('Checking files.', true)).toBe(true);
    expect(shouldKeepBriefRendered('Checking files.', false)).toBe(false);
  });

  it('never keeps a long brief rendered as the preview pane', () => {
    expect(shouldKeepBriefRendered('one\ntwo\nthree\nfour', null)).toBe(false);
    expect(shouldKeepBriefRendered('one\ntwo\nthree\nfour', true)).toBe(false);
  });
});

describe('resolveBriefPillExpanded', () => {
  it('auto-expands the active live brief and auto-collapses when superseded', () => {
    expect(resolveBriefPillExpanded(true, true, null, 'one\ntwo\nthree\nfour')).toBe(true);
    expect(resolveBriefPillExpanded(true, false, null, 'one\ntwo\nthree\nfour')).toBe(false);
    expect(resolveBriefPillExpanded(false, false, null, 'one\ntwo\nthree\nfour')).toBe(false);
  });

  it('keeps a short brief expanded after it is no longer the live event', () => {
    expect(resolveBriefPillExpanded(true, false, null, 'Checking files.')).toBe(true);
    expect(resolveBriefPillExpanded(false, false, null, 'Checking files.')).toBe(true);
  });

  it('honors a user expand/collapse override', () => {
    expect(resolveBriefPillExpanded(true, false, true, 'one\ntwo\nthree\nfour')).toBe(true);
    expect(resolveBriefPillExpanded(true, true, false, 'Checking files.')).toBe(false);
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
