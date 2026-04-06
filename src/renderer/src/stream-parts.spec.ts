import type { StreamPart } from '@shared/index';
import {
  isPrimaryAssistantStreamTag,
  primaryAssistantTextFromParts,
  primaryStreamPartsForDisplay,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  streamIndicatesNestedSpecialistRouting,
  streamPlainOneLine,
} from '@shared/index';

describe('isPrimaryAssistantStreamTag', () => {
  it('treats agent and legacy mgr as primary', () => {
    expect(isPrimaryAssistantStreamTag('mgr')).toBe(true);
    expect(isPrimaryAssistantStreamTag('agent')).toBe(true);
    expect(isPrimaryAssistantStreamTag(' mgr ')).toBe(true);
  });

  it('rejects nested and worker tags', () => {
    expect(isPrimaryAssistantStreamTag('worker')).toBe(false);
    expect(isPrimaryAssistantStreamTag('planning')).toBe(false);
    expect(isPrimaryAssistantStreamTag('spec-read-abc123')).toBe(false);
  });
});

describe('primaryAssistantTextFromParts', () => {
  it('prefers agent chunks over planning and legacy mgr', () => {
    const parts: StreamPart[] = [
      { streamTag: 'mgr', label: 'Manager', text: 'legacy ' },
      { streamTag: 'planning', label: 'Planning', text: 'ignore' },
      { streamTag: 'agent', label: 'Reply', text: 'Hello ' },
      { streamTag: 'agent', label: 'Reply', text: 'world' },
    ];
    expect(primaryAssistantTextFromParts(parts)).toBe('Hello world');
  });

  it('uses legacy mgr when no agent text', () => {
    const parts: StreamPart[] = [
      { streamTag: 'planning', label: 'Planning', text: 'x' },
      { streamTag: 'mgr', label: 'Manager', text: 'mgr only' },
    ];
    expect(primaryAssistantTextFromParts(parts)).toBe('mgr only');
  });

  it('uses agent when present alongside planning', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: 'Reply', text: 'Single ' },
      { streamTag: 'planning', label: 'Planning', text: 'x' },
      { streamTag: 'agent', label: 'Reply', text: 'tier' },
    ];
    expect(primaryAssistantTextFromParts(parts)).toBe('Single tier');
  });

  it('falls back to worker when no agent or mgr text', () => {
    const parts: StreamPart[] = [
      { streamTag: 'planning', label: 'Planning', text: 'a' },
      { streamTag: 'worker', label: 'Workspace worker', text: 'W' },
    ];
    expect(primaryAssistantTextFromParts(parts)).toBe('W');
  });

  it('does not persist nested-only streams (planning/spec) when no primary tags', () => {
    const parts: StreamPart[] = [{ streamTag: 'planning', label: 'Planning', text: 'only' }];
    expect(primaryAssistantTextFromParts(parts)).toBe('');
  });

  it('does not join spec-* text into the saved reply without agent/mgr/worker', () => {
    const parts: StreamPart[] = [{ streamTag: 'spec-read-abc', label: 'R', text: 'nested' }];
    expect(primaryAssistantTextFromParts(parts)).toBe('');
  });

  it('returns empty string for empty parts', () => {
    expect(primaryAssistantTextFromParts([])).toBe('');
  });
});

describe('shouldIgnoreWhitespaceOnlyModelChunkDuringTool', () => {
  it('drops whitespace-only deltas only while a tool run is in progress', () => {
    expect(shouldIgnoreWhitespaceOnlyModelChunkDuringTool('\n\n', true)).toBe(true);
    expect(shouldIgnoreWhitespaceOnlyModelChunkDuringTool('  \t', true)).toBe(true);
    expect(shouldIgnoreWhitespaceOnlyModelChunkDuringTool('a', true)).toBe(false);
    expect(shouldIgnoreWhitespaceOnlyModelChunkDuringTool('\n', false)).toBe(false);
  });
});

describe('streamPlainOneLine', () => {
  it('collapses newlines and whitespace for live preview', () => {
    expect(streamPlainOneLine('a\n\nb')).toBe('a b');
    expect(streamPlainOneLine('  x  \t y ')).toBe(' x y ');
  });
});

describe('streamIndicatesNestedSpecialistRouting', () => {
  it('is true for planning or spec-* tags', () => {
    expect(streamIndicatesNestedSpecialistRouting([])).toBe(false);
    expect(
      streamIndicatesNestedSpecialistRouting([
        { streamTag: 'worker', label: 'W', text: 'x' },
      ]),
    ).toBe(false);
    expect(
      streamIndicatesNestedSpecialistRouting([
        { streamTag: 'planning', label: 'P', text: 'x' },
      ]),
    ).toBe(true);
    expect(
      streamIndicatesNestedSpecialistRouting([
        { streamTag: 'spec-read-abc', label: 'R', text: 'x' },
      ]),
    ).toBe(true);
  });
});

describe('primaryStreamPartsForDisplay', () => {
  it('shows agent and legacy mgr as primary', () => {
    const parts: StreamPart[] = [
      { streamTag: 'planning', label: 'Planning', text: 'x' },
      { streamTag: 'mgr', label: 'Manager', text: 'y' },
      { streamTag: 'agent', label: 'Reply', text: 'z' },
    ];
    expect(primaryStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'mgr', label: 'Manager', text: 'y' },
      { streamTag: 'agent', label: 'Reply', text: 'z' },
    ]);
  });
});
