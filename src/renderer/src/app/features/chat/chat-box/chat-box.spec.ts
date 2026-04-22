import type { PlannerProgress } from '@shared/index';
import {
  buildChatDisplayRows,
  filterLiveToolChainGroups,
  isScrollWorthyAppendMessage,
  TOOL_BUILDING_SYNONYMS,
  type ChatMessage,
  type ToolChainGroup,
} from './chat-box';

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

  it('preserves persisted shell tool streams on the assistant row', () => {
    const toolStreams = [
      { streamTag: 'spec-project_review-tests', label: 'Workspace Pytest', text: '1 passed\n' },
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

  it('preserves persisted moeStreams on the assistant row', () => {
    const moeStreams = [{ streamTag: 'moe', label: 'Model reasoning', text: 'internal chain' }];
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Q' },
      { role: 'assistant', text: 'A.', moeStreams },
    ];
    const rows = buildChatDisplayRows(messages);
    expect(rows.length).toBe(2);
    expect(rows[1].kind).toBe('assistant-turn');
    if (rows[1].kind !== 'assistant-turn') return;
    expect(rows[1].assistant?.moeStreams).toEqual(moeStreams);
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

  it('hides nested planner groups until the plan is ready', () => {
    const planner: PlannerProgress = { streamTag: 'planner', phase: 'discovery', planReady: false, steps: [] };
    expect(filterLiveToolChainGroups(groups, planner)).toEqual([groups[0]]);
  });

  it('shows nested planner groups after the task list is published', () => {
    const planner: PlannerProgress = { streamTag: 'planner', phase: 'planning', planReady: true, steps: [] };
    expect(filterLiveToolChainGroups(groups, planner)).toEqual([groups[0], groups[2]]);
  });

  it('shows nested planning/specialist tool rows even when plan is not ready (execute_workspace_mutation path)', () => {
    const planningGroup: ToolChainGroup = {
      key: 'planning-router',
      toolCallCount: 1,
      rows: [
        {
          role: 'chain',
          label: 'route_write_specialist',
          text: '',
          state: 'running',
          source: 'tool',
          statusId: 'nest-1',
          streamTag: 'planning',
        },
      ],
    };
    const plannerNotReady: PlannerProgress = { streamTag: 'planner', phase: 'discovery', planReady: false, steps: [] };
    expect(filterLiveToolChainGroups([groups[0], planningGroup], plannerNotReady)).toEqual([groups[0], planningGroup]);
  });

  it('shows Clara-only groups when planner progress is absent (e.g. router-only plan_and_modify)', () => {
    const claraGroup: ToolChainGroup = {
      key: 'clara',
      toolCallCount: 0,
      rows: [
        {
          role: 'chain',
          label: 'Project review',
          text: 'Approved.',
          state: 'complete',
          source: 'agent',
          statusId: 'b1',
          streamTag: 'clara',
        },
      ],
    };
    expect(filterLiveToolChainGroups([groups[0], claraGroup], null)).toEqual([groups[0], claraGroup]);
  });

  it('hides Clara-only handoff groups until the planner checklist is ready', () => {
    const claraGroup: ToolChainGroup = {
      key: 'clara',
      toolCallCount: 0,
      rows: [
        {
          role: 'chain',
          label: 'Planner checklist',
          text: '1. a',
          state: 'complete',
          source: 'agent',
          statusId: 'b1',
          streamTag: 'clara',
        },
      ],
    };
    const plannerNotReady: PlannerProgress = { streamTag: 'planner', phase: 'discovery', planReady: false, steps: [] };
    expect(filterLiveToolChainGroups([groups[0], claraGroup], plannerNotReady)).toEqual([groups[0]]);
    const plannerReady: PlannerProgress = { streamTag: 'planner', phase: 'planning', planReady: true, steps: [] };
    expect(filterLiveToolChainGroups([groups[0], claraGroup], plannerReady)).toEqual([groups[0], claraGroup]);
  });
});
