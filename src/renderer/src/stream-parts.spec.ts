import type { StreamPart } from '@shared/index';
import {
  auxiliaryTimelineEmbedsToolStatus,
  delegatedStreamPartsForDisplay,
  isClaraOuterBriefStreamTag,
  isMoeAuxiliaryStreamTag,
  isPrimaryAssistantStreamTag,
  isShellStyleToolStreamTag,
  isToolTrailStatusStreamTag,
  joinPrimaryAssistantStreamText,
  moeStreamPartsForDisplay,
  MOE_AUXILIARY_STREAM_TAG,
  multiplexAuxiliaryStreamTimeline,
  otherDelegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  persistedAuxiliaryStreamTimeline,
  primaryAssistantTextFromParts,
  primaryStreamPartsForDisplay,
  shellDelegatedStreamPartsForDisplay,
  SHELL_STYLE_TOOL_STREAM_TAGS,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  streamIndicatesNestedSpecialistRouting,
  streamPlainOneLine,
  toolTrailStatusStreamTag,
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

describe('isClaraOuterBriefStreamTag', () => {
  it('matches the clara multiplex tag with trimming', () => {
    expect(isClaraOuterBriefStreamTag('clara')).toBe(true);
    expect(isClaraOuterBriefStreamTag(' clara ')).toBe(true);
    expect(isClaraOuterBriefStreamTag(undefined)).toBe(false);
    expect(isClaraOuterBriefStreamTag('planning')).toBe(false);
  });
});

describe('emptyPrimaryAssistantFallbackMessage', () => {
  it('explains reasoning-only turns when pseudo-tool text was stripped from the main channel', () => {
    expect(emptyPrimaryAssistantFallbackMessage(true)).toContain('Model reasoning');
    expect(emptyPrimaryAssistantFallbackMessage(true)).toContain('main reply');
  });

  it('keeps the tooling-oriented copy when there was no reasoning sidecar', () => {
    expect(emptyPrimaryAssistantFallbackMessage(false)).toContain('Workspace tooling finished');
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

describe('joinPrimaryAssistantStreamText', () => {
  it('joins agent parts preserving newlines', () => {
    const parts = [
      { streamTag: 'agent', label: '', text: '## Hi\n\n' },
      { streamTag: 'planner', label: '', text: 'ignored' },
      { streamTag: 'agent', label: '', text: 'Body' },
    ];
    expect(joinPrimaryAssistantStreamText(parts)).toBe('## Hi\n\nBody');
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

describe('delegatedStreamPartsForDisplay', () => {
  it('keeps nested tool execution streams out of the saved primary reply', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: 'Reply', text: 'done' },
      { streamTag: 'spec-code_review-tests', label: 'Pytest', text: '1 passed' },
    ];
    expect(delegatedStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'spec-code_review-tests', label: 'Pytest', text: '1 passed' },
    ]);
  });
});

describe('multiplexAuxiliaryStreamTimeline', () => {
  it('preserves interleaved order and drops primary tags', () => {
    const parts: StreamPart[] = [
      { streamTag: 'moe', label: 'R', text: 'a' },
      { streamTag: 'spec-x-tests', label: 'T', text: 'b' },
      { streamTag: 'agent', label: 'Reply', text: 'ignored here' },
      { streamTag: 'moe', label: 'R', text: 'c' },
    ];
    expect(multiplexAuxiliaryStreamTimeline(parts)).toEqual([
      { streamTag: 'moe', label: 'R', text: 'a' },
      { streamTag: 'spec-x-tests', label: 'T', text: 'b' },
      { streamTag: 'moe', label: 'R', text: 'c' },
    ]);
  });

  it('keeps embedded tool-trail status segments between reasoning chunks', () => {
    const tid = toolTrailStatusStreamTag('run-1');
    const parts: StreamPart[] = [
      { streamTag: 'moe', label: 'Model reasoning', text: 'Planning…' },
      { streamTag: tid, label: 'read_file', text: 'path', toolChainState: 'running' },
      { streamTag: 'moe', label: 'Model reasoning', text: ' more' },
    ];
    expect(multiplexAuxiliaryStreamTimeline(parts)).toEqual(parts);
    expect(isToolTrailStatusStreamTag(tid)).toBe(true);
    expect(auxiliaryTimelineEmbedsToolStatus(parts)).toBe(true);
  });
});

describe('toolTrailStatusStreamTag', () => {
  it('encodes ids safely and matches isToolTrailStatusStreamTag', () => {
    const id = 'a/b c';
    const tag = toolTrailStatusStreamTag(id);
    expect(tag.startsWith('tool-trail:')).toBe(true);
    expect(isToolTrailStatusStreamTag(tag)).toBe(true);
    expect(isToolTrailStatusStreamTag('moe')).toBe(false);
  });
});

describe('persistedAuxiliaryStreamTimeline', () => {
  it('prefers auxiliaryStreamTimeline when set', () => {
    const ordered: StreamPart[] = [
      { streamTag: 'spec-x-tests', label: 'T', text: 'first' },
      { streamTag: 'moe', label: 'R', text: 'second' },
    ];
    expect(
      persistedAuxiliaryStreamTimeline({
        toolStreams: [{ streamTag: 'spec-y-tests', label: 'Y', text: 'legacy tool' }],
        moeStreams: [{ streamTag: 'moe', label: 'R', text: 'legacy moe' }],
        auxiliaryStreamTimeline: ordered,
      }),
    ).toEqual(ordered);
  });

  it('falls back to toolStreams then moeStreams when timeline absent', () => {
    expect(
      persistedAuxiliaryStreamTimeline({
        toolStreams: [{ streamTag: 'spec-x-tests', label: 'T', text: 't' }],
        moeStreams: [{ streamTag: 'moe', label: 'R', text: 'm' }],
      }),
    ).toEqual([
      { streamTag: 'spec-x-tests', label: 'T', text: 't' },
      { streamTag: 'moe', label: 'R', text: 'm' },
    ]);
  });

  it('returns empty for null assistant', () => {
    expect(persistedAuxiliaryStreamTimeline(null)).toEqual([]);
  });
});

describe('Reasoning auxiliary stream tag', () => {
  it('uses a single canonical tag string', () => {
    expect(MOE_AUXILIARY_STREAM_TAG).toBe('moe');
    expect(isMoeAuxiliaryStreamTag('moe')).toBe(true);
    expect(isMoeAuxiliaryStreamTag(' moe ')).toBe(true);
    expect(isMoeAuxiliaryStreamTag('agent')).toBe(false);
  });

  it('partitions moe away from shell and other delegated streams', () => {
    const parts: StreamPart[] = [
      { streamTag: 'planning', label: 'P', text: 'plan' },
      { streamTag: 'moe', label: 'Reasoning', text: 'think' },
      { streamTag: 'spec-x-tests', label: 'T', text: 'out' },
    ];
    expect(moeStreamPartsForDisplay(parts, null)).toEqual([{ streamTag: 'moe', label: 'Reasoning', text: 'think' }]);
    expect(shellDelegatedStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'spec-x-tests', label: 'T', text: 'out' },
    ]);
    expect(otherDelegatedStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'planning', label: 'P', text: 'plan' },
    ]);
  });
});

describe('isShellStyleToolStreamTag', () => {
  it('is true for project review pytest and smoke tags', () => {
    expect(isShellStyleToolStreamTag('spec-project_review-tests')).toBe(true);
    expect(isShellStyleToolStreamTag('spec-project_review-smoke')).toBe(true);
    expect(isShellStyleToolStreamTag('spec-code_review-tests')).toBe(true);
  });

  it('is false for planning and generic spec subgraphs', () => {
    expect(isShellStyleToolStreamTag('planning')).toBe(false);
    expect(isShellStyleToolStreamTag('planner')).toBe(false);
    expect(isShellStyleToolStreamTag('spec-create-abc12')).toBe(false);
    expect(isShellStyleToolStreamTag('worker')).toBe(false);
  });

  it('trims whitespace in the tag', () => {
    expect(isShellStyleToolStreamTag('  spec-x-tests  ')).toBe(true);
  });

  it('exposes an allowlist set for tags that do not match -tests/-smoke suffixes', () => {
    expect(SHELL_STYLE_TOOL_STREAM_TAGS).toBeInstanceOf(Set);
    for (const tag of SHELL_STYLE_TOOL_STREAM_TAGS) {
      expect(isShellStyleToolStreamTag(tag)).toBe(true);
    }
  });
});
