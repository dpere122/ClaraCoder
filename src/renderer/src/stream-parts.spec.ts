import type { StreamPart } from '@shared/index';
import {
  auxiliaryTimelineEmbedsToolStatus,
  delegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  isClaraOuterBriefStreamTag,
  isPrimaryAssistantStreamTag,
  isReasoningAuxiliaryStreamTag,
  isShellStyleToolStreamTag,
  isToolTrailStatusStreamTag,
  joinPrimaryAssistantStreamText,
  multiplexAuxiliaryStreamTimeline,
  normalizeStreamPart,
  normalizeStreamTag,
  normalizeReasoningStreamPart,
  otherDelegatedStreamPartsForDisplay,
  persistedAuxiliaryStreamTimeline,
  persistedReasoningStreams,
  primaryAssistantTextFromParts,
  primaryStreamPartsForDisplay,
  appendAndMergeReadToolPreviewChunk,
  appendReadToolPreviewChunk,
  mergeReadPreviewIntoToolTrailParts,
  READ_TOOL_PREVIEW_STREAM_TAG,
  reasoningStreamPartsForDisplay,
  REASONING_AUXILIARY_STREAM_TAG,
  shellDelegatedStreamPartsForDisplay,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  streamPlainOneLine,
  TOOL_OVERLAY_STREAM_TAG,
  TOOL_PYTEST_STREAM_TAG,
  toolTrailStatusStreamTag,
} from '@shared/index';

describe('isPrimaryAssistantStreamTag', () => {
  it('treats only agent as primary', () => {
    expect(isPrimaryAssistantStreamTag('agent')).toBe(true);
    expect(isPrimaryAssistantStreamTag(' mgr ')).toBe(false);
    expect(isPrimaryAssistantStreamTag('worker')).toBe(false);
    expect(isPrimaryAssistantStreamTag('planning')).toBe(false);
    expect(isPrimaryAssistantStreamTag('tool-pytest')).toBe(false);
  });
});

describe('isClaraOuterBriefStreamTag', () => {
  it('matches clara only', () => {
    expect(isClaraOuterBriefStreamTag('clara')).toBe(true);
    expect(isClaraOuterBriefStreamTag('planning')).toBe(false);
  });
});

describe('normalizeStreamTag', () => {
  it('drops removed legacy tags', () => {
    expect(normalizeStreamTag('mgr')).toBeNull();
    expect(normalizeStreamTag('worker')).toBeNull();
    expect(normalizeStreamTag('planning')).toBeNull();
  });

  it('keeps planner tag for plan-and-execute mode', () => {
    expect(normalizeStreamTag('planner')).toBe('planner');
  });

  it('maps legacy spec-* tags to canonical tool tags', () => {
    expect(normalizeStreamTag('spec-read-preview')).toBe(READ_TOOL_PREVIEW_STREAM_TAG);
    expect(normalizeStreamTag('spec-code_review-overlay')).toBe(TOOL_OVERLAY_STREAM_TAG);
    expect(normalizeStreamTag('spec-project_review-tests')).toBe(TOOL_PYTEST_STREAM_TAG);
  });
});

describe('primaryAssistantTextFromParts', () => {
  it('uses only agent chunks', () => {
    const parts: StreamPart[] = [
      { streamTag: 'mgr', label: 'Manager', text: 'legacy ' },
      { streamTag: 'agent', label: 'Reply', text: 'hello' },
      { streamTag: 'tool-pytest', label: 'T', text: 'ignored' },
    ];
    expect(primaryAssistantTextFromParts(parts)).toBe('hello');
  });

  it('returns empty when no agent text', () => {
    const parts: StreamPart[] = [{ streamTag: 'planning', label: 'Planning', text: 'only' }];
    expect(primaryAssistantTextFromParts(parts)).toBe('');
  });
});

describe('joinPrimaryAssistantStreamText', () => {
  it('joins agent chunks only', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: 'Reply', text: 'line1\n' },
      { streamTag: 'reasoning', label: 'R', text: 'think' },
      { streamTag: 'agent', label: 'Reply', text: 'line2' },
    ];
    expect(joinPrimaryAssistantStreamText(parts)).toBe('line1\nline2');
  });
});

describe('mergeReadPreviewIntoToolTrailParts', () => {
  it('folds read-preview chunks into the matching tool-trail row', () => {
    const trailTag = toolTrailStatusStreamTag('read-1');
    const parts: StreamPart[] = [
      { streamTag: trailTag, label: 'read_workspace_file', text: 'src/a.py', toolChainState: 'complete' },
      { streamTag: READ_TOOL_PREVIEW_STREAM_TAG, label: 'File read preview', text: '\n\n── read_workspace_file ──\n1 │ x\n' },
    ];
    expect(mergeReadPreviewIntoToolTrailParts(parts)).toEqual([
      {
        streamTag: trailTag,
        label: 'read_workspace_file',
        text: 'src/a.py\n\n── read_workspace_file ──\n1 │ x\n',
        toolChainState: 'complete',
      },
    ]);
  });
});

describe('appendAndMergeReadToolPreviewChunk', () => {
  it('folds orphan preview onto the tool-trail row in one step', () => {
    const trailTag = toolTrailStatusStreamTag('read-3');
    const parts: StreamPart[] = [
      { streamTag: trailTag, label: 'read_workspace_file', text: 'src/a.py', toolChainState: 'running' },
    ];
    const out = appendAndMergeReadToolPreviewChunk(parts, '\n\n── read_workspace_file ──\n  1 │ x\n');
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('── read_workspace_file ──');
    expect(out[0].text).toContain('  1 │ x');
  });
});

describe('appendReadToolPreviewChunk', () => {
  it('appends onto the last read tool-trail row', () => {
    const trailTag = toolTrailStatusStreamTag('read-2');
    const parts: StreamPart[] = [
      { streamTag: trailTag, label: 'read_staged_edit', text: 'draft.ts', toolChainState: 'running' },
    ];
    const out = appendReadToolPreviewChunk(parts, '\nbody');
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('draft.ts\nbody');
  });
});

describe('multiplexAuxiliaryStreamTimeline', () => {
  it('preserves interleaved order and drops primary tags', () => {
    const parts: StreamPart[] = [
      { streamTag: 'reasoning', label: 'R', text: 'a' },
      { streamTag: 'tool-pytest', label: 'T', text: 'b' },
      { streamTag: 'agent', label: 'Reply', text: 'ignored here' },
      { streamTag: 'reasoning', label: 'R', text: 'c' },
    ];
    expect(multiplexAuxiliaryStreamTimeline(parts)).toEqual([
      { streamTag: 'reasoning', label: 'R', text: 'a' },
      { streamTag: 'tool-pytest', label: 'T', text: 'b' },
      { streamTag: 'reasoning', label: 'R', text: 'c' },
    ]);
  });

  it('normalizes legacy spec-* tags and omits removed lanes', () => {
    const parts: StreamPart[] = [
      { streamTag: 'moe', label: 'R', text: 'legacy reasoning' },
      { streamTag: 'spec-project_review-tests', label: 'T', text: 'out' },
      { streamTag: 'planning', label: 'P', text: 'drop' },
    ];
    expect(multiplexAuxiliaryStreamTimeline(parts)).toEqual([
      { streamTag: 'reasoning', label: 'R', text: 'legacy reasoning' },
      { streamTag: 'tool-pytest', label: 'T', text: 'out' },
    ]);
  });
});

describe('persistedAuxiliaryStreamTimeline', () => {
  it('falls back to toolStreams then reasoningStreams with normalization', () => {
    expect(
      persistedAuxiliaryStreamTimeline({
        toolStreams: [{ streamTag: 'spec-x-tests', label: 'T', text: 't' }],
        reasoningStreams: [{ streamTag: 'reasoning', label: 'R', text: 'r' }],
      }),
    ).toEqual([
      { streamTag: 'tool-pytest', label: 'T', text: 't' },
      { streamTag: 'reasoning', label: 'R', text: 'r' },
    ]);
  });

  it('prefers reasoningStreams over legacy moeStreams', () => {
    expect(
      persistedReasoningStreams({
        reasoningStreams: [{ streamTag: 'reasoning', label: 'R', text: 'new' }],
        moeStreams: [{ streamTag: 'moe', label: 'R', text: 'old' }],
      }),
    ).toEqual([{ streamTag: 'reasoning', label: 'R', text: 'new' }]);
  });
});

describe('shell and delegated partitions', () => {
  it('partitions reasoning away from shell and overlay streams', () => {
    const parts: StreamPart[] = [
      { streamTag: 'tool-overlay', label: 'O', text: 'overlay' },
      { streamTag: 'reasoning', label: 'Reasoning', text: 'think' },
      { streamTag: 'tool-pytest', label: 'T', text: 'out' },
    ];
    expect(reasoningStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'reasoning', label: 'Reasoning', text: 'think' },
    ]);
    expect(shellDelegatedStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'tool-pytest', label: 'T', text: 'out' },
    ]);
    expect(otherDelegatedStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'tool-overlay', label: 'O', text: 'overlay' },
    ]);
    expect(delegatedStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'tool-overlay', label: 'O', text: 'overlay' },
      { streamTag: 'reasoning', label: 'Reasoning', text: 'think' },
      { streamTag: 'tool-pytest', label: 'T', text: 'out' },
    ]);
  });
});

describe('isShellStyleToolStreamTag', () => {
  it('matches canonical shell tool tags only', () => {
    expect(isShellStyleToolStreamTag('tool-pytest')).toBe(true);
    expect(isShellStyleToolStreamTag('tool-smoke')).toBe(true);
    expect(isShellStyleToolStreamTag('tool-node-smoke')).toBe(true);
    expect(isShellStyleToolStreamTag('tool-overlay')).toBe(false);
    expect(isShellStyleToolStreamTag('planning')).toBe(false);
    expect(normalizeStreamTag('spec-project_review-tests')).toBe('tool-pytest');
  });
});

describe('Reasoning auxiliary stream tag', () => {
  it('uses a single canonical tag string', () => {
    expect(REASONING_AUXILIARY_STREAM_TAG).toBe('reasoning');
    expect(isReasoningAuxiliaryStreamTag('reasoning')).toBe(true);
    expect(isReasoningAuxiliaryStreamTag('moe')).toBe(true);
    expect(normalizeReasoningStreamPart({ streamTag: 'moe', label: 'R', text: 'x' })).toEqual({
      streamTag: 'reasoning',
      label: 'R',
      text: 'x',
    });
  });
});

describe('toolTrailStatusStreamTag', () => {
  it('encodes ids safely', () => {
    const tag = toolTrailStatusStreamTag('run-1');
    expect(isToolTrailStatusStreamTag(tag)).toBe(true);
    expect(isToolTrailStatusStreamTag('reasoning')).toBe(false);
    expect(auxiliaryTimelineEmbedsToolStatus([{ streamTag: tag, label: 'x', text: '' }])).toBe(true);
  });
});

describe('emptyPrimaryAssistantFallbackMessage', () => {
  it('mentions reasoning when sidecar was present', () => {
    expect(emptyPrimaryAssistantFallbackMessage(true)).toContain('Model reasoning');
  });
});

describe('streamPlainOneLine', () => {
  it('collapses whitespace', () => {
    expect(streamPlainOneLine('a\n\n  b')).toBe('a b');
  });
});

describe('shouldIgnoreWhitespaceOnlyModelChunkDuringTool', () => {
  it('ignores whitespace-only chunks during tool runs', () => {
    expect(shouldIgnoreWhitespaceOnlyModelChunkDuringTool('   ', true)).toBe(true);
    expect(shouldIgnoreWhitespaceOnlyModelChunkDuringTool('x', true)).toBe(false);
  });
});

describe('normalizeStreamPart', () => {
  it('returns null for removed tags', () => {
    expect(normalizeStreamPart({ streamTag: 'mgr', label: '', text: 'x' })).toBeNull();
  });
});

describe('primaryStreamPartsForDisplay', () => {
  it('shows agent only', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: 'Reply', text: 'hi' },
      { streamTag: 'reasoning', label: 'R', text: 'think' },
    ];
    expect(primaryStreamPartsForDisplay(parts, null)).toEqual([
      { streamTag: 'agent', label: 'Reply', text: 'hi' },
    ]);
  });
});
