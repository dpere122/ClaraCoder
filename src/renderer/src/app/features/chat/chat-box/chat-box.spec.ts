import type { PlannerProgress, StreamPart } from '@shared/index';
import { persistedAuxiliaryStreamTimeline } from '@shared/index';
import {
  auxiliaryPanelTitleFromChainGroups,
  buildChatDisplayRows,
  decideChatScrollOnAppend,
  decideInstantScrollOnStreamingUpdate,
  decideStickAfterUserScroll,
  extractLatestBriefLine,
  filterLiveToolChainGroups,
  isChatTranscriptScrollable,
  isPendingHitlArtifact,
  isScrollWorthyAppendMessage,
  isStickFromSlack,
  liveTurnPresentationSettled,
  mergeClaraBriefsFromChainIntoTimeline,
  pendingHitlArtifactsForDock,
  resolveLiveAssistantTurn,
  resolvePrimaryStreamLiveText,
  latestPrimaryStreamSegmentText,
  SCROLL_BOTTOM_PIN_THRESHOLD_PX,
  scrollSlackPx,
  shouldFollowStreamComplete,
  shouldFollowStreamToken,
  shouldShowJumpToBottom,
  turnHasPendingHitlArtifacts,
  TOOL_BUILDING_SYNONYMS,
  unseenBelowAfterScroll,
  type ChatMessage,
  type ToolChainGroup,
} from './chat-box-display';
import { mergeHitlTrailIntoAuxiliaryTimeline } from '@shared/index';

describe('buildChatDisplayRows', () => {
  it('groups chain rows and diff cards into the same assistant turn', () => {
    const planner: PlannerProgress = {
      streamTag: 'planner',
      phase: 'complete',
      steps: [
        { id: 'step-1', text: 'Inspect UI', state: 'complete' },
        { id: 'step-2', text: 'Render checklist', state: 'complete' },
      ],
    };
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Update the chat box' },
      { role: 'chain', label: 'Workspace', text: 'Thinking...', state: 'running', source: 'agent', statusId: 'agent-1' },
      { role: 'chain', label: 'record_plan', text: 'Initial plan recorded.', state: 'complete', source: 'tool', statusId: 'tool-1', streamTag: 'planner' },
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'src/app.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: 'updated content',
          truncated: false,
        },
        reviewStatus: 'pending',
      },
      { role: 'chain', label: 'execute_plan_step', text: 'Applied edit.', state: 'complete', source: 'tool', statusId: 'tool-2', streamTag: 'planner' },
      { role: 'assistant', text: 'Updated the chat box.', planner },
    ];

    const rows = buildChatDisplayRows(messages);

    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ kind: 'user', msg: messages[0] });
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].chainGroups.length).toBe(2);
    expect(rows[1].chainGroups[0].toolCallCount).toBe(1);
    expect(rows[1].chainGroups[1].toolCallCount).toBe(1);
    expect(rows[1].chainGroups.flatMap((group) => group.rows).every((row) => row.source === 'tool')).toBe(true);
    expect(rows[1].artifacts.length).toBe(1);
    expect(rows[1].assistant?.planner).toEqual(planner);
  });

  it('keeps a trailing in-flight assistant turn without a final assistant message', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Do work' },
      { role: 'chain', label: 'record_plan', text: 'Planning...', state: 'running', source: 'tool', statusId: 'tool-1', streamTag: 'planner' },
      {
        role: 'delete_confirm',
        payload: { version: 1, requestId: 'req-1', relativePath: 'tmp.txt', kind: 'file', recursive: false },
        reviewStatus: 'pending',
      },
    ];

    const rows = buildChatDisplayRows(messages);

    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].assistant).toBeNull();
    expect(rows[1].chainGroups.length).toBe(1);
    expect(rows[1].artifacts.length).toBe(1);
    expect(resolveLiveAssistantTurn(rows)).toBe(rows[1]);
  });

  it('keeps copy confirmation artifacts grouped with the assistant turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Duplicate files' },
      { role: 'chain', label: 'copy_workspace_files', text: 'Awaiting approval', state: 'complete', source: 'tool', statusId: 'tool-copy' },
      {
        role: 'copy_confirm',
        payload: {
          version: 1,
          requestId: 'copy-1',
          overwrite: false,
          copies: [{ sourcePath: 'a.txt', destinationPath: 'copies/a.txt' }],
        },
        reviewStatus: 'pending',
      },
    ];

    const rows = buildChatDisplayRows(messages);

    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].assistant).toBeNull();
    expect(rows[1].chainGroups.length).toBe(1);
    expect(rows[1].artifacts).toHaveLength(1);
    expect(rows[1].artifacts[0].role).toBe('copy_confirm');
  });

  it('keeps generic accept-command artifacts grouped with the assistant turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Install pytest' },
      { role: 'chain', label: 'install_python_packages', text: 'Awaiting approval', state: 'complete', source: 'tool', statusId: 'tool-deps' },
      {
        role: 'accept_command',
        payload: {
          version: 1,
          requestId: 'accept-1',
          kind: 'python_dependency',
          title: 'Install Python packages',
          message: 'Install package(s) into the active workspace virtual environment.',
          confirmLabel: 'Install packages',
          cancelLabel: 'Cancel',
          commandText: 'python -m pip install pytest',
          details: ['Workspace root: `.`', 'Packages: `pytest`'],
        },
        reviewStatus: 'pending',
      },
    ];

    const rows = buildChatDisplayRows(messages);

    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].assistant).toBeNull();
    expect(rows[1].chainGroups.length).toBe(1);
    expect(rows[1].artifacts).toHaveLength(1);
    expect(rows[1].artifacts[0].role).toBe('accept_command');
  });

  it('hides agent-only status rows from the chat bubble stream', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Do work' },
      { role: 'chain', label: 'Agent', text: 'Thinking...', state: 'running', source: 'agent', statusId: 'agent-1' },
      { role: 'assistant', text: 'Done.' },
    ];

    const rows = buildChatDisplayRows(messages);

    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].chainGroups).toEqual([]);
  });

  it('shows Clara outer brief rows (streamTag clara) even when source is agent', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'go' },
      {
        role: 'chain',
        label: 'Planner checklist',
        text: '1. First\n2. Second',
        state: 'complete',
        source: 'agent',
        statusId: 'brief-1',
        streamTag: 'clara',
      },
      { role: 'assistant', text: 'Done.' },
    ];

    const rows = buildChatDisplayRows(messages);

    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].chainGroups.length).toBe(1);
    expect(rows[1].chainGroups[0].rows).toHaveLength(1);
    expect(rows[1].chainGroups[0].rows[0].streamTag).toBe('clara');
    expect(rows[1].chainGroups[0].toolCallCount).toBe(0);
  });

  it('folds persisted Clara chain briefs into the turn timeline when missing from auxiliary parts', () => {
    const groups: ToolChainGroup[] = [
      {
        key: 'brief-1',
        rows: [
          {
            role: 'chain',
            label: 'Clara',
            text: 'Checking the layout next.',
            state: 'complete',
            source: 'agent',
            statusId: 'brief-1',
            streamTag: 'clara',
          },
        ],
        toolCallCount: 0,
      },
    ];
    const merged = mergeClaraBriefsFromChainIntoTimeline(
      [{ streamTag: 'reasoning', label: 'R', text: 'think' }],
      groups,
    );
    expect(merged[0]).toEqual({
      streamTag: 'clara',
      label: 'Clara',
      text: 'Checking the layout next.',
    });
    expect(merged[1]?.streamTag).toBe('reasoning');
  });

  it('does not duplicate chain briefs when the timeline already has clara parts', () => {
    const groups: ToolChainGroup[] = [
      {
        key: 'brief-1',
        rows: [
          {
            role: 'chain',
            label: 'Clara',
            text: 'from chain',
            state: 'complete',
            source: 'agent',
            statusId: 'brief-1',
            streamTag: 'clara',
          },
        ],
        toolCallCount: 0,
      },
    ];
    const timeline: StreamPart[] = [{ streamTag: 'clara', label: 'Clara', text: 'from stream' }];
    expect(mergeClaraBriefsFromChainIntoTimeline(timeline, groups)).toEqual(timeline);
  });

  it('preserves persisted shell tool streams on the assistant row', () => {
    const toolStreams = [
      { streamTag: 'tool-pytest', label: 'Workspace Pytest', text: '1 passed\n' },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Review' },
      { role: 'assistant', text: 'Review complete.', toolStreams },
    ];

    const rows = buildChatDisplayRows(messages);

    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].assistant?.toolStreams).toEqual(toolStreams);
  });

  it('preserves persisted reasoningStreams on the assistant row', () => {
    const reasoningStreams = [
      { streamTag: 'reasoning', label: 'Model reasoning', text: 'internal chain' },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Q' },
      { role: 'assistant', text: 'A.', reasoningStreams },
    ];
    const rows = buildChatDisplayRows(messages);
    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].assistant?.reasoningStreams).toEqual(reasoningStreams);
  });

  it('preserves persisted auxiliaryStreamTimeline on the assistant row', () => {
    const auxiliaryStreamTimeline: StreamPart[] = [
      { streamTag: 'reasoning', label: 'Model reasoning', text: 'think' },
      { streamTag: 'tool-pytest', label: 'Pytest', text: 'ok\n' },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Q' },
      { role: 'assistant', text: 'A.', auxiliaryStreamTimeline },
    ];
    const rows = buildChatDisplayRows(messages);
    expect(rows.length).toBe(2);
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].assistant?.auxiliaryStreamTimeline).toEqual(auxiliaryStreamTimeline);
    expect(persistedAuxiliaryStreamTimeline(rows[1].assistant)).toEqual(auxiliaryStreamTimeline);
  });

  it('embeds HITL change rows into the persisted auxiliary timeline', () => {
    const auxiliaryStreamTimeline: StreamPart[] = [
      { streamTag: 'reasoning', label: 'Model reasoning', text: 'think' },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Edit' },
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'src/app.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
        reviewStatus: 'complete',
      },
      { role: 'assistant', text: 'Done.', auxiliaryStreamTimeline },
    ];
    const rows = buildChatDisplayRows(messages);
    expect(rows[1]?.kind).toBe('assistant-turn');
    if (rows[1]?.kind !== 'assistant-turn') return;
    const merged = mergeHitlTrailIntoAuxiliaryTimeline(
      persistedAuxiliaryStreamTimeline(rows[1].assistant),
      rows[1].artifacts,
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]?.label).toBe('app.ts');
  });
});

describe('pendingHitlArtifactsForDock', () => {
  it('returns pending artifacts from the latest assistant turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Edit' },
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
        reviewStatus: 'pending',
      },
      {
        role: 'plan_confirm',
        payload: {
          version: 1,
          requestId: 'p1',
          title: 'Plan',
          message: '',
          confirmLabel: 'Go',
          cancelLabel: 'Cancel',
          steps: ['one'],
          filesToChange: [],
          currentImplementation: '',
          risks: [],
          definitionOfDone: [],
          resolvedQuestions: [],
        },
        reviewStatus: 'pending',
      },
    ];
    const pending = pendingHitlArtifactsForDock(messages);
    expect(pending).toHaveLength(2);
    expect(pending.map((a) => a.role)).toEqual(['diff', 'plan_confirm']);
  });

  it('returns empty when the latest turn has no pending reviews', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Q' },
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
        reviewStatus: 'complete',
      },
      { role: 'assistant', text: 'Done.' },
    ];
    expect(pendingHitlArtifactsForDock(messages)).toEqual([]);
  });
});

describe('TOOL_BUILDING_SYNONYMS', () => {
  it('lists twelve lowercase tool-phase labels', () => {
    expect(TOOL_BUILDING_SYNONYMS).toHaveLength(12);
    for (const w of TOOL_BUILDING_SYNONYMS) {
      expect(w).toBe(w.toLowerCase());
      expect(w).toMatch(/^[a-z]+$/);
    }
  });
});

describe('auxiliaryPanelTitleFromChainGroups', () => {
  it('uses the latest Clara update as the reasoning panel title', () => {
    const groups: ToolChainGroup[] = [
      {
        key: 'tools',
        toolCallCount: 1,
        rows: [
          {
            role: 'chain',
            label: 'read_file',
            text: 'Reading files',
            state: 'running',
            source: 'tool',
            statusId: 'tool-1',
          },
        ],
      },
      {
        key: 'clara',
        toolCallCount: 0,
        rows: [
          {
            role: 'chain',
            label: 'Clara update',
            text: 'Reviewing streamed markdown formatting\nand reasoning title behavior.',
            state: 'complete',
            source: 'agent',
            statusId: 'clara-1',
            streamTag: 'clara',
          },
        ],
      },
    ];

    expect(auxiliaryPanelTitleFromChainGroups(groups)).toBe(
      'Reviewing streamed markdown formatting and reasoning title behavior.',
    );
  });
});

describe('isPendingHitlArtifact', () => {
  it('is true only while review is pending', () => {
    const diff: ChatMessage = {
      role: 'diff',
      payload: {
        version: 1,
        relativePath: 'a.ts',
        language: 'typescript',
        rows: [],
        fullNewContent: '',
        truncated: false,
      },
      reviewStatus: 'pending',
    };
    expect(isPendingHitlArtifact(diff)).toBe(true);
    expect(isPendingHitlArtifact({ ...diff, reviewStatus: 'complete' })).toBe(false);

    const rows = buildChatDisplayRows([{ role: 'user', text: 'edit' }, diff]);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(turnHasPendingHitlArtifacts(rows[1].artifacts)).toBe(true);
    const done = rows[1].artifacts.map((a) => ({ ...a, reviewStatus: 'complete' as const }));
    expect(turnHasPendingHitlArtifacts(done)).toBe(false);
  });
});

describe('isScrollWorthyAppendMessage', () => {
  it('returns true for roles that grow the visible transcript', () => {
    expect(isScrollWorthyAppendMessage({ role: 'user', text: 'hi' })).toBe(true);
    expect(isScrollWorthyAppendMessage({ role: 'assistant', text: 'ok' })).toBe(true);
    expect(
      isScrollWorthyAppendMessage({
        role: 'chain',
        label: 'x',
        text: '',
        state: 'running',
        source: 'tool',
        statusId: '1',
      }),
    ).toBe(true);
    expect(
      isScrollWorthyAppendMessage({
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
        reviewStatus: 'pending',
      }),
    ).toBe(true);
  });
});

const hitlDiffMessage: ChatMessage = {
  role: 'diff',
  payload: {
    version: 1,
    relativePath: 'a.ts',
    language: 'typescript',
    rows: [],
    fullNewContent: '',
    truncated: false,
  },
  reviewStatus: 'pending',
};

describe('stick/roam scroll policy', () => {
  it('treats slack within 48px as stick and beyond as roam', () => {
    expect(scrollSlackPx(1000, 900, 80)).toBe(20);
    expect(isStickFromSlack(0)).toBe(true);
    expect(isStickFromSlack(SCROLL_BOTTOM_PIN_THRESHOLD_PX)).toBe(true);
    expect(isStickFromSlack(SCROLL_BOTTOM_PIN_THRESHOLD_PX + 1)).toBe(false);
  });

  it('treats a short transcript as not scrollable', () => {
    expect(isChatTranscriptScrollable(400, 400)).toBe(false);
    expect(isChatTranscriptScrollable(401, 400)).toBe(false);
    expect(isChatTranscriptScrollable(402, 400)).toBe(true);
  });

  it('hides the jump button unless roam and the transcript overflows', () => {
    expect(shouldShowJumpToBottom(true, true)).toBe(false);
    expect(shouldShowJumpToBottom(false, false)).toBe(false);
    expect(shouldShowJumpToBottom(true, false)).toBe(false);
    expect(shouldShowJumpToBottom(false, true)).toBe(true);
  });

  it('follows user, assistant, and HITL appends while stick', () => {
    expect(
      decideChatScrollOnAppend({
        stickMode: true,
        added: [{ role: 'user', text: 'hi' }],
        loading: false,
      }),
    ).toEqual({ follow: true, badge: false });
    expect(
      decideChatScrollOnAppend({
        stickMode: true,
        added: [{ role: 'assistant', text: 'ok' }],
        loading: false,
      }),
    ).toEqual({ follow: true, badge: false });
    expect(
      decideChatScrollOnAppend({
        stickMode: true,
        added: [hitlDiffMessage],
        loading: true,
      }),
    ).toEqual({ follow: true, badge: false });
  });

  it('does not follow in-stream assistant/chain appends while stick (live feed handles them)', () => {
    expect(
      decideChatScrollOnAppend({
        stickMode: true,
        added: [{ role: 'assistant', text: 'partial' }],
        loading: true,
      }),
    ).toEqual({ follow: false, badge: false });
  });

  it('badges and stays put for user, assistant, and HITL appends while roam', () => {
    expect(
      decideChatScrollOnAppend({
        stickMode: false,
        added: [{ role: 'user', text: 'next' }],
        loading: false,
      }),
    ).toEqual({ follow: false, badge: true });
    expect(
      decideChatScrollOnAppend({
        stickMode: false,
        added: [{ role: 'assistant', text: 'ok' }],
        loading: false,
      }),
    ).toEqual({ follow: false, badge: true });
    expect(
      decideChatScrollOnAppend({
        stickMode: false,
        added: [hitlDiffMessage],
        loading: true,
      }),
    ).toEqual({ follow: false, badge: true });
  });

  it('leaves stick on any user scroll-up, even during programmatic follow', () => {
    expect(
      decideStickAfterUserScroll({
        scrolledUp: true,
        scrolledDown: false,
        nearBottom: true,
        programmatic: true,
        stickMode: true,
        scrollable: true,
      }),
    ).toBe('roam');
    expect(
      decideStickAfterUserScroll({
        scrolledUp: true,
        scrolledDown: false,
        nearBottom: false,
        programmatic: false,
        stickMode: true,
        scrollable: true,
      }),
    ).toBe('roam');
  });

  it('stays in stick when the transcript is not scrollable, even on scroll-up', () => {
    expect(
      decideStickAfterUserScroll({
        scrolledUp: true,
        scrolledDown: false,
        nearBottom: true,
        programmatic: false,
        stickMode: true,
        scrollable: false,
      }),
    ).toBe('stick');
  });

  it('re-sticks only when the user scrolls down to the bottom, not on resize while roam', () => {
    expect(
      decideStickAfterUserScroll({
        scrolledUp: false,
        scrolledDown: true,
        nearBottom: true,
        programmatic: false,
        stickMode: false,
        scrollable: true,
      }),
    ).toBe('stick');
    expect(
      decideStickAfterUserScroll({
        scrolledUp: false,
        scrolledDown: false,
        nearBottom: true,
        programmatic: false,
        stickMode: false,
        scrollable: true,
      }),
    ).toBe('keep');
    expect(
      decideStickAfterUserScroll({
        scrolledUp: false,
        scrolledDown: false,
        nearBottom: true,
        programmatic: true,
        stickMode: true,
        scrollable: true,
      }),
    ).toBe('keep');
  });

  it('follows stream tokens and completion only while stick', () => {
    expect(shouldFollowStreamToken(true, true)).toBe(true);
    expect(shouldFollowStreamToken(false, true)).toBe(false);
    expect(shouldFollowStreamToken(true, false)).toBe(false);
    expect(shouldFollowStreamComplete(true)).toBe(true);
    expect(shouldFollowStreamComplete(false)).toBe(false);
  });

  it('clears the unseen badge when returning to stick', () => {
    expect(unseenBelowAfterScroll(true, true)).toBe(false);
    expect(unseenBelowAfterScroll(false, true)).toBe(true);
    expect(unseenBelowAfterScroll(false, false)).toBe(false);
  });
});

describe('decideInstantScrollOnStreamingUpdate', () => {
  const empty = { prevPrimaryKey: '', prevAuxKey: '', prevAuxPanelVisible: false };

  it('scrolls immediately when primary reply grows', () => {
    expect(
      decideInstantScrollOnStreamingUpdate(
        { primaryKey: '12:hello world', auxKey: '', auxPanelVisible: false },
        empty,
      ),
    ).toEqual({
      scrollNow: true,
      scrollAfterLayout: false,
      next: { prevPrimaryKey: '12:hello world', prevAuxKey: '', prevAuxPanelVisible: false },
    });
  });

  it('scrolls after layout when the live details panel first reveals', () => {
    expect(
      decideInstantScrollOnStreamingUpdate(
        { primaryKey: '', auxKey: '', auxPanelVisible: true },
        empty,
      ),
    ).toEqual({
      scrollNow: false,
      scrollAfterLayout: true,
      next: { prevPrimaryKey: '', prevAuxKey: '', prevAuxPanelVisible: true },
    });
  });

  it('does not scroll when auxiliary content starts before the panel reveals', () => {
    expect(
      decideInstantScrollOnStreamingUpdate(
        {
          primaryKey: '',
          auxKey: 'reasoning:Model reasoning:42',
          auxPanelVisible: false,
        },
        empty,
      ),
    ).toEqual({
      scrollNow: false,
      scrollAfterLayout: false,
      next: {
        prevPrimaryKey: '',
        prevAuxKey: 'reasoning:Model reasoning:42',
        prevAuxPanelVisible: false,
      },
    });
  });

  it('ignores ongoing auxiliary-only growth after the panel has revealed', () => {
    const prev = {
      prevPrimaryKey: '',
      prevAuxKey: 'reasoning:Model reasoning:42',
      prevAuxPanelVisible: true,
    };
    expect(
      decideInstantScrollOnStreamingUpdate(
        {
          primaryKey: '',
          auxKey: 'reasoning:Model reasoning:128',
          auxPanelVisible: true,
        },
        prev,
      ),
    ).toEqual({
      scrollNow: false,
      scrollAfterLayout: false,
      next: {
        prevPrimaryKey: '',
        prevAuxKey: 'reasoning:Model reasoning:128',
        prevAuxPanelVisible: true,
      },
    });
  });
});

describe('filterLiveToolChainGroups', () => {
  const groups: ToolChainGroup[] = [
    {
      key: 'outer',
      toolCallCount: 1,
      rows: [{ role: 'chain', label: 'Outer tool', text: '', state: 'running', source: 'tool', statusId: 'outer-1' }],
    },
    {
      key: 'hidden-agent',
      toolCallCount: 0,
      rows: [],
    },
    {
      key: 'nested',
      toolCallCount: 1,
      rows: [
        {
          role: 'chain',
          label: 'execute_plan_step',
          text: '',
          state: 'running',
          source: 'tool',
          statusId: 'planner-1',
          streamTag: 'planner',
        },
      ],
    },
  ];

  it('keeps tool chain groups that have visible rows', () => {
    expect(filterLiveToolChainGroups(groups)).toEqual([groups[0], groups[2]]);
  });

  it('drops empty tool chain groups', () => {
    const emptyGroup: ToolChainGroup = { key: 'empty', toolCallCount: 0, rows: [] };
    expect(filterLiveToolChainGroups([groups[0], emptyGroup])).toEqual([groups[0]]);
  });
});

describe('liveTurnPresentationSettled', () => {
  it('is true when plan is visible without final prose', () => {
    expect(liveTurnPresentationSettled(true, '', '')).toBe(true);
    expect(liveTurnPresentationSettled(true, 'brief', '')).toBe(false);
    expect(liveTurnPresentationSettled(false, '', '')).toBe(false);
  });
});

describe('resolvePrimaryStreamLiveText', () => {
  it('returns empty when no final text or primary stream is available', () => {
    expect(resolvePrimaryStreamLiveText(undefined, [], false)).toBe('');
    expect(resolvePrimaryStreamLiveText('   ', [], false)).toBe('');
  });

  it('prefers trimmed final text over streamed segments', () => {
    const parts = [{ streamTag: 'agent', label: '', text: 'Streaming…' }];
    expect(resolvePrimaryStreamLiveText('  Hello world  ', parts, false)).toBe('Hello world');
  });

  it('streams the latest primary agent segment while loading', () => {
    const parts = [
      { streamTag: 'agent', label: '', text: 'Brief status\n' },
      { streamTag: 'tool-trail:read', label: 'read_workspace_file', text: 'Reading…' },
      { streamTag: 'agent', label: '', text: 'Here is the answer.' },
    ];
    expect(resolvePrimaryStreamLiveText(undefined, parts, false)).toBe('Here is the answer.');
  });

  it('keeps streaming primary while tools phase is engaged (clear_primary_stream drops stale prose)', () => {
    const parts = [{ streamTag: 'agent', label: '', text: 'Here is the answer.' }];
    expect(resolvePrimaryStreamLiveText(undefined, parts, true)).toBe('Here is the answer.');
  });

  it('shows empty primary when agent segments were cleared for tools', () => {
    expect(resolvePrimaryStreamLiveText(undefined, [{ streamTag: 'reasoning', label: '', text: 'think' }], true)).toBe(
      '',
    );
  });
});

describe('latestPrimaryStreamSegmentText', () => {
  it('returns the last agent segment after multiplex rows', () => {
    const parts = [
      { streamTag: 'agent', label: '', text: 'First' },
      { streamTag: 'reasoning', label: '', text: 'Thinking' },
      { streamTag: 'agent', label: '', text: 'Second' },
    ];
    expect(latestPrimaryStreamSegmentText(parts)).toBe('Second');
  });
});

describe('extractLatestBriefLine', () => {
  it('uses the last non-empty line and truncates long titles', () => {
    expect(extractLatestBriefLine('first\n\nChecking files…')).toBe('Checking files…');
    const long = 'x'.repeat(130);
    expect(extractLatestBriefLine(long).endsWith('...')).toBe(true);
  });
});
