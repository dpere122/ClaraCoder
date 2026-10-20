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
  buildTurnFeed,
  isActiveLiveThought,
  isActiveLiveNudge,
  turnFeedScrollKey,
  normalizeStreamPart,
  normalizeStreamTag,
  normalizeReasoningStreamPart,
  otherDelegatedStreamPartsForDisplay,
  persistedAuxiliaryStreamTimeline,
  persistedReasoningStreams,
  primaryAssistantTextFromParts,
  clearPrimaryStreamParts,
  isToolLikeStreamTag,
  isInFlightToolPart,
  promotePrimaryToNudgeParts,
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
  hitlTrailStreamTag,
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

describe('isToolLikeStreamTag', () => {
  it('does not treat planner rows as tools', () => {
    expect(isToolLikeStreamTag('planner')).toBe(false);
    const parts: StreamPart[] = [
      { streamTag: 'planner', label: 'Plan', text: 'step 1' },
      { streamTag: 'agent', label: '', text: 'live reply' },
      { streamTag: 'planner', label: 'Plan', text: 'step 2' },
    ];
    const feed = buildTurnFeed(parts);
    expect(feed.some((item) => item.kind === 'thought')).toBe(false);
    expect(feed.some((item) => item.kind === 'markdown' && item.text.includes('live reply'))).toBe(true);
  });
});

describe('isInFlightToolPart', () => {
  it('treats running tool-trail rows as in flight', () => {
    expect(
      isInFlightToolPart({
        streamTag: toolTrailStatusStreamTag('read-1'),
        label: 'read_workspace_file',
        text: 'src/app.ts',
        toolChainState: 'running',
      }),
    ).toBe(true);
  });

  it('does not treat completed or HITL rows as in flight', () => {
    expect(
      isInFlightToolPart({
        streamTag: toolTrailStatusStreamTag('read-1'),
        label: 'read_workspace_file',
        text: 'done',
        toolChainState: 'complete',
      }),
    ).toBe(false);
    expect(
      isInFlightToolPart({
        streamTag: hitlTrailStreamTag('diff-1'),
        label: 'diff',
        text: 'pending',
        toolChainState: 'running',
      }),
    ).toBe(false);
  });

  it('treats incomplete shell and run-command streams as in flight', () => {
    expect(
      isInFlightToolPart({
        streamTag: TOOL_PYTEST_STREAM_TAG,
        label: 'pytest',
        text: 'running tests',
      }),
    ).toBe(true);
    expect(
      isInFlightToolPart({
        streamTag: 'run-command:abc',
        label: 'run_command',
        text: 'npm test',
        runComplete: true,
      }),
    ).toBe(false);
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

  it('appends onto the row named by statusId while parallel reads run', () => {
    const parts: StreamPart[] = [
      { streamTag: toolTrailStatusStreamTag('r1'), label: 'read_workspace_file', text: 'hello.py', toolChainState: 'running' },
      { streamTag: toolTrailStatusStreamTag('r2'), label: 'search_workspace', text: 'greet', toolChainState: 'running' },
    ];
    const out = appendReadToolPreviewChunk(parts, '\n\n── read_workspace_file ──\nbody', 'r1');
    expect(out[0].text).toBe('hello.py\n\n── read_workspace_file ──\nbody');
    expect(out[1].text).toBe('greet');
  });

  it('falls back to the last read row when the statusId row is missing', () => {
    const parts: StreamPart[] = [
      { streamTag: toolTrailStatusStreamTag('r1'), label: 'read_workspace_file', text: 'a.py', toolChainState: 'running' },
    ];
    expect(appendReadToolPreviewChunk(parts, '\nbody', 'gone')[0].text).toBe('a.py\nbody');
  });
});

describe('buildTurnFeed', () => {
  it('returns empty for empty parts', () => {
    expect(buildTurnFeed([])).toEqual([]);
    expect(buildTurnFeed([], '   ')).toEqual([]);
  });

  it('interleaves thought, tool, and agent markdown in arrival order', () => {
    const parts: StreamPart[] = [
      { streamTag: 'reasoning', label: 'R', text: 'think first' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'Reading…' },
      { streamTag: 'agent', label: '', text: 'Here is the answer.' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'thought', part: parts[0] },
      { kind: 'tool', part: parts[1] },
      { kind: 'markdown', text: 'Here is the answer.' },
    ]);
  });

  it('renders Clara outer briefs as inline markdown, not pills or tool rows', () => {
    const parts: StreamPart[] = [
      { streamTag: 'clara', label: 'Clara', text: 'Checking the layout next.' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'done' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'markdown', text: 'Checking the layout next.' },
      { kind: 'tool', part: parts[1] },
    ]);
  });

  it('renders live pre-tool agent prose as markdown', () => {
    const parts: StreamPart[] = [
      { streamTag: 'reasoning', label: 'R', text: 'think first' },
      { streamTag: 'agent', label: '', text: 'Checking the layout next.' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'thought', part: parts[0] },
      { kind: 'markdown', text: 'Checking the layout next.' },
    ]);
  });

  it('merges consecutive pre-tool agent segments into one markdown block', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: '', text: 'Hello ' },
      { streamTag: 'agent', label: '', text: 'world' },
    ];
    expect(buildTurnFeed(parts)).toEqual([{ kind: 'markdown', text: 'Hello world' }]);
  });

  it('renders live pre-tool agent prose as markdown with a HITL trail row present', () => {
    const parts: StreamPart[] = [
      { streamTag: hitlTrailStreamTag('change-1'), label: 'edit src/a.ts', text: 'pending' },
      { streamTag: 'agent', label: '', text: 'Checking the layout next.' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'tool', part: parts[0] },
      { kind: 'markdown', text: 'Checking the layout next.' },
    ]);
  });

  it('keeps briefs rendered between tool calls alongside the post-tool reply', () => {
    const parts: StreamPart[] = [
      { streamTag: 'clara', label: 'Clara', text: 'Checking files.' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'Reading…' },
      { streamTag: 'agent', label: '', text: 'Here is the answer.' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'markdown', text: 'Checking files.' },
      { kind: 'tool', part: parts[1] },
      { kind: 'markdown', text: 'Here is the answer.' },
    ]);
  });

  it('keeps persisted briefs between tool calls when final_text is set', () => {
    const parts: StreamPart[] = [
      { streamTag: 'clara', label: 'Clara', text: 'First I will read the file.' },
      { streamTag: 'tool-trail:a', label: 'read_workspace_file', text: 'done' },
      { streamTag: 'clara', label: 'Clara', text: 'Now listing the directory.' },
      { streamTag: 'tool-trail:b', label: 'list_workspace_directory', text: 'done' },
    ];
    expect(buildTurnFeed(parts, 'Here is the answer.')).toEqual([
      { kind: 'markdown', text: 'First I will read the file.' },
      { kind: 'tool', part: parts[1] },
      { kind: 'markdown', text: 'Now listing the directory.' },
      { kind: 'tool', part: parts[3] },
      { kind: 'markdown', text: 'Here is the answer.' },
    ]);
  });

  it('skips blank Clara brief parts', () => {
    const parts: StreamPart[] = [{ streamTag: 'clara', label: 'Clara', text: '   ' }];
    expect(buildTurnFeed(parts)).toEqual([]);
  });

  it('renders promoted nudge parts as nudge pills, not markdown', () => {
    const parts: StreamPart[] = [
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'done' },
      { streamTag: 'nudge', label: 'Nudge', text: 'Done staging.' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'tool', part: parts[0] },
      { kind: 'nudge', part: parts[1] },
    ]);
  });

  it('merges consecutive nudge segments', () => {
    const parts: StreamPart[] = [
      { streamTag: 'nudge', label: 'Nudge', text: 'First. ' },
      { streamTag: 'nudge', label: 'Nudge', text: 'Second.' },
    ];
    const feed = buildTurnFeed(parts);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.kind).toBe('nudge');
    if (feed[0]?.kind !== 'nudge') return;
    expect(feed[0].part.text).toBe('First. Second.');
  });

  it('replaces in-feed agent markdown with final_text at the end', () => {
    const parts: StreamPart[] = [
      { streamTag: 'reasoning', label: 'R', text: 'think' },
      { streamTag: 'agent', label: '', text: 'Streaming…' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'done' },
      { streamTag: 'agent', label: '', text: 'Draft answer' },
    ];
    expect(buildTurnFeed(parts, '  Final reply  ')).toEqual([
      { kind: 'thought', part: parts[0] },
      { kind: 'tool', part: parts[2] },
      { kind: 'markdown', text: 'Final reply' },
    ]);
  });

  it('keeps agent prose between tools rendered as markdown, even when final_text is set', () => {
    const parts: StreamPart[] = [
      { streamTag: 'reasoning', label: 'R', text: 'first think' },
      { streamTag: 'tool-trail:a', label: 'read_workspace_file', text: 'done' },
      { streamTag: 'agent', label: '', text: 'I should list files next' },
      { streamTag: 'tool-trail:b', label: 'list_workspace_directory', text: 'done' },
      { streamTag: 'agent', label: '', text: 'Here is the answer.' },
    ];
    expect(buildTurnFeed(parts, 'Here is the answer.')).toEqual([
      { kind: 'thought', part: parts[0] },
      { kind: 'tool', part: parts[1] },
      { kind: 'markdown', text: 'I should list files next' },
      { kind: 'tool', part: parts[3] },
      { kind: 'markdown', text: 'Here is the answer.' },
    ]);
  });

  it('renders live between-tool agent prose as markdown, not a thought pill', () => {
    const parts: StreamPart[] = [
      { streamTag: 'tool-trail:a', label: 'read_workspace_file', text: 'done' },
      { streamTag: 'agent', label: '', text: 'Need the directory next' },
      { streamTag: 'tool-trail:b', label: 'list_workspace_directory', text: 'listing' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'tool', part: parts[0] },
      { kind: 'markdown', text: 'Need the directory next' },
      { kind: 'tool', part: parts[2] },
    ]);
  });

  it('merges consecutive post-tool agent segments into one markdown item', () => {
    const parts: StreamPart[] = [
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'done' },
      { streamTag: 'agent', label: '', text: 'Hello ' },
      { streamTag: 'agent', label: '', text: 'world' },
    ];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'tool', part: parts[0] },
      { kind: 'markdown', text: 'Hello world' },
    ]);
  });

  it('skips blank reasoning and agent parts', () => {
    const parts: StreamPart[] = [
      { streamTag: 'reasoning', label: 'R', text: '   ' },
      { streamTag: 'agent', label: '', text: '\n' },
      { streamTag: 'tool-pytest', label: 'T', text: '' },
    ];
    expect(buildTurnFeed(parts)).toEqual([{ kind: 'tool', part: parts[2] }]);
  });

  it('normalizes legacy moe reasoning tags', () => {
    const parts: StreamPart[] = [{ streamTag: 'moe', label: 'R', text: 'legacy' }];
    expect(buildTurnFeed(parts)).toEqual([
      { kind: 'thought', part: { streamTag: 'reasoning', label: 'R', text: 'legacy' } },
    ]);
  });
});

describe('isActiveLiveThought', () => {
  const thought = { kind: 'thought' as const, part: { streamTag: 'reasoning', label: 'R', text: 'x' } };
  const tool = { kind: 'tool' as const, part: { streamTag: 'tool-trail:a', label: 'read', text: '' } };

  it('is true only for the last live thought (unused by live turn-feed preview queue)', () => {
    expect(isActiveLiveThought([thought], 0, true)).toBe(true);
    expect(isActiveLiveThought([thought, tool], 0, true)).toBe(false);
    expect(isActiveLiveThought([thought], 0, false)).toBe(false);
  });
});

describe('isActiveLiveNudge', () => {
  const nudge = { kind: 'nudge' as const, part: { streamTag: 'nudge', label: 'Nudge', text: 'Done staging.' } };
  const thought = { kind: 'thought' as const, part: { streamTag: 'reasoning', label: 'R', text: 'x' } };
  const tool = { kind: 'tool' as const, part: { streamTag: 'tool-trail:a', label: 'read', text: '' } };
  const md = { kind: 'markdown' as const, text: 'done' };

  it('is true for the live nudge while it is still being generated', () => {
    expect(isActiveLiveNudge([nudge], 0, true)).toBe(true);
    expect(isActiveLiveNudge([nudge], 0, false)).toBe(false);
  });

  it('stays active when thought tokens arrive after the nudge', () => {
    expect(isActiveLiveNudge([nudge, thought], 0, true)).toBe(true);
  });

  it('closes when a tool, markdown reply, or newer nudge follows', () => {
    expect(isActiveLiveNudge([nudge, tool], 0, true)).toBe(false);
    expect(isActiveLiveNudge([nudge, md], 0, true)).toBe(false);
    expect(isActiveLiveNudge([nudge, { ...nudge, part: { ...nudge.part, text: 'later' } }], 0, true)).toBe(
      false,
    );
  });
});

describe('turnFeedScrollKey', () => {
  it('changes when markdown or part text grows', () => {
    const a = turnFeedScrollKey([{ kind: 'markdown', text: 'Hi' }]);
    const b = turnFeedScrollKey([{ kind: 'markdown', text: 'Hello' }]);
    expect(a).not.toBe(b);
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

describe('clearPrimaryStreamParts', () => {
  it('promotes agent segments to Clara briefs and keeps auxiliary trails', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: '', text: 'Planning…' },
      { streamTag: 'reasoning', label: 'R', text: 'think' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'Reading…' },
    ];
    expect(clearPrimaryStreamParts(parts)).toEqual([
      { streamTag: 'clara', label: 'Clara', text: 'Planning…' },
      { streamTag: 'reasoning', label: 'R', text: 'think' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'Reading…' },
    ]);
  });

  it('merges consecutive promoted agent segments into one brief', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: '', text: 'First. ' },
      { streamTag: 'agent', label: '', text: 'Second.' },
    ];
    expect(clearPrimaryStreamParts(parts)).toEqual([
      { streamTag: 'clara', label: 'Clara', text: 'First. Second.' },
    ]);
  });

  it('drops whitespace-only agent segments', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: '', text: '  \n' },
      { streamTag: 'reasoning', label: 'R', text: 'think' },
    ];
    expect(clearPrimaryStreamParts(parts)).toEqual([
      { streamTag: 'reasoning', label: 'R', text: 'think' },
    ]);
  });
});

describe('promotePrimaryToNudgeParts', () => {
  it('promotes agent segments to nudge and keeps auxiliary trails', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: '', text: 'Done staging.' },
      { streamTag: 'reasoning', label: 'R', text: 'think' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'Reading…' },
    ];
    expect(promotePrimaryToNudgeParts(parts)).toEqual([
      { streamTag: 'nudge', label: 'Nudge', text: 'Done staging.' },
      { streamTag: 'reasoning', label: 'R', text: 'think' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'Reading…' },
    ]);
  });

  it('does not retag Clara briefs', () => {
    const parts: StreamPart[] = [
      { streamTag: 'clara', label: 'Clara', text: 'Checking files.' },
      { streamTag: 'agent', label: '', text: 'Here is the answer.' },
    ];
    expect(promotePrimaryToNudgeParts(parts)).toEqual([
      { streamTag: 'clara', label: 'Clara', text: 'Checking files.' },
      { streamTag: 'nudge', label: 'Nudge', text: 'Here is the answer.' },
    ]);
  });
});
