import { parseAgentStreamPayload } from '@shared/index';

describe('parseAgentStreamPayload', () => {
  it('parses status payloads and normalizes legacy snake_case fields', () => {
    const parsed = parseAgentStreamPayload(
      JSON.stringify({
        type: 'status',
        status: {
          id: 'agent-done',
          label: 'Agent',
          detail: 'Complete',
          state: 'complete',
          source: 'agent',
          agent_role: 'worker',
          stream_tag: 'planning',
        },
      }),
    );

    expect(parsed).toEqual({
      type: 'status',
      status: {
        id: 'agent-done',
        label: 'Agent',
        detail: 'Complete',
        state: 'complete',
        source: 'agent',
        agentRole: 'worker',
        streamTag: 'planning',
      },
    });
  });

  it('parses clear_primary_stream payloads', () => {
    expect(parseAgentStreamPayload(JSON.stringify({ type: 'clear_primary_stream' }))).toEqual({
      type: 'clear_primary_stream',
    });
  });

  it('parses promote_primary_to_nudge payloads', () => {
    expect(parseAgentStreamPayload(JSON.stringify({ type: 'promote_primary_to_nudge' }))).toEqual({
      type: 'promote_primary_to_nudge',
    });
  });

  it('parses tool execution chunks with optional label and stream tag', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_chunk',
          delta: '1 passed\n',
          stream_tag: 'tool-pytest',
          label: 'Pytest',
        }),
      ),
    ).toEqual({
      type: 'tool_exec_chunk',
      delta: '1 passed\n',
      streamTag: 'tool-pytest',
      label: 'Pytest',
    });
  });

  it('parses tool_exec_complete with outcome', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'tool-smoke',
          exit_code: -15,
          outcome: 'passed',
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'tool-smoke',
      exitCode: -15,
      outcome: 'passed',
    });
  });

  it('parses tool_exec_complete with exit_code', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'tool-pytest',
          label: 'Workspace Pytest',
          exit_code: 0,
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'tool-pytest',
      label: 'Workspace Pytest',
      exitCode: 0,
    });

    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'tool-pytest',
          exit_code: null,
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'tool-pytest',
      exitCode: null,
    });

    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'tool-smoke',
          exit_code: 1,
          output_excerpt: 'Traceback (most recent call last):',
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'tool-smoke',
      exitCode: 1,
      outputExcerpt: 'Traceback (most recent call last):',
    });
  });

  it('parses review payload variants without falling back to plain chunks', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'file_journal',
          fileJournal: {
            userMessageId: 'u1',
            op: 'modify',
            relativePath: 'src/a.ts',
            beforeContent: 'old',
          },
        }),
      ),
    ).toEqual({
      type: 'file_journal',
      fileJournal: {
        userMessageId: 'u1',
        op: 'modify',
        relativePath: 'src/a.ts',
        beforeContent: 'old',
        beforeEncoding: undefined,
        beforeNewline: undefined,
        destRelativePath: undefined,
        treeEntries: undefined,
      },
    });

    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'diff',
          diff: {
            version: 1,
            relativePath: 'src/app.ts',
            language: 'typescript',
            rows: [],
            fullNewContent: 'next',
            truncated: false,
          },
        }),
      ),
    ).toEqual({
      type: 'diff',
      diff: {
        version: 1,
        relativePath: 'src/app.ts',
        language: 'typescript',
        rows: [],
        fullNewContent: 'next',
        truncated: false,
      },
    });

    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'accept_command',
          acceptCommand: {
            version: 1,
            requestId: 'accept-1',
            kind: 'python_dependency',
            title: 'Install packages',
            message: 'Install into the workspace venv.',
            confirmLabel: 'Install',
            cancelLabel: 'Cancel',
            commandText: 'python -m pip install pytest',
            details: [],
          },
        }),
      ),
    ).toEqual({
      type: 'accept_command',
      acceptCommand: {
        version: 1,
        requestId: 'accept-1',
        kind: 'python_dependency',
        title: 'Install packages',
        message: 'Install into the workspace venv.',
        confirmLabel: 'Install',
        cancelLabel: 'Cancel',
        commandText: 'python -m pip install pytest',
        details: [],
      },
    });
  });

  it('parses background_command_open payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'background_command_open',
          command_id: 'abc12345',
          command_text: 'npm run dev',
          cwd_label: '.',
          label: 'npm run dev',
          stream_tag: 'run-command:abc12345',
        }),
      ),
    ).toEqual({
      type: 'background_command_open',
      commandId: 'abc12345',
      commandText: 'npm run dev',
      cwdLabel: '.',
      label: 'npm run dev',
      streamTag: 'run-command:abc12345',
    });
  });

  it('falls back to a plain text chunk for unknown payloads', () => {
    expect(parseAgentStreamPayload('not-json')).toEqual({
      type: 'chunk',
      delta: 'not-json',
    });
  });

  it('parses context_compressed payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'context_compressed',
          tokens_before: 12000,
          tokens_after: 8000,
          tool_messages_compacted: 3,
          tool_rounds_dropped: 1,
        }),
      ),
    ).toEqual({
      type: 'context_compressed',
      tokensBefore: 12000,
      tokensAfter: 8000,
      toolMessagesCompacted: 3,
      toolRoundsDropped: 1,
    });
  });

  it('parses planner_progress payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'planner_progress',
          planner: {
            streamTag: 'planner',
            phase: 'planning',
            planReady: true,
            steps: [{ id: 'step-1', text: 'Inspect', state: 'pending' }],
          },
        }),
      ),
    ).toEqual({
      type: 'planner_progress',
      planner: {
        streamTag: 'planner',
        phase: 'planning',
        planReady: true,
        steps: [{ id: 'step-1', text: 'Inspect', state: 'pending' }],
      },
    });
  });

  it('parses plan_confirm payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'plan_confirm',
          planConfirm: {
            version: 1,
            requestId: 'plan-abc',
            title: 'Review plan',
            message: 'Approve steps',
            confirmLabel: 'Run plan',
            cancelLabel: 'Cancel',
            steps: ['Step one'],
            filesToChange: [
              { path: 'src/new.ts', operation: 'create', rationale: 'add module' },
              'src/legacy.ts — old string',
            ],
          },
        }),
      ),
    ).toEqual({
      type: 'plan_confirm',
      planConfirm: {
        version: 1,
        requestId: 'plan-abc',
        title: 'Review plan',
        message: 'Approve steps',
        confirmLabel: 'Run plan',
        cancelLabel: 'Cancel',
        steps: ['Step one'],
        filesToChange: [
          { path: 'src/new.ts', operation: 'create', rationale: 'add module' },
          { path: 'src/legacy.ts', operation: 'modify', rationale: 'old string' },
        ],
      },
    });
  });

  it('parses agent_question payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'agent_question',
          agentQuestion: {
            version: 1,
            requestId: 'q-abc',
            title: 'Clarify the plan',
            message: 'Answer a few questions',
            submitLabel: 'Submit answers',
            cancelLabel: 'Cancel',
            questions: [
              {
                id: 'q-1',
                prompt: 'Use REST or gRPC?',
                options: [{ id: 'q-1-opt-1', label: 'REST' }],
                allowOther: true,
              },
            ],
            planId: 'plan-1',
          },
        }),
      ),
    ).toEqual({
      type: 'agent_question',
      agentQuestion: {
        version: 1,
        requestId: 'q-abc',
        title: 'Clarify the plan',
        message: 'Answer a few questions',
        submitLabel: 'Submit answers',
        cancelLabel: 'Cancel',
        questions: [
          {
            id: 'q-1',
            prompt: 'Use REST or gRPC?',
            options: [{ id: 'q-1-opt-1', label: 'REST' }],
            allowOther: true,
          },
        ],
        planId: 'plan-1',
      },
    });
  });

  it('parses build_plan_open payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'build_plan_open',
          buildPlanOpen: {
            planId: 'plan-1',
            relativePath: '.nemo/build-plans/plan-1.md',
            title: 'Refactor auth',
            previewMode: true,
          },
        }),
      ),
    ).toEqual({
      type: 'build_plan_open',
      buildPlanOpen: {
        planId: 'plan-1',
        relativePath: '.nemo/build-plans/plan-1.md',
        title: 'Refactor auth',
        previewMode: true,
      },
    });
  });

  it('parses build_plan_chunk payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'build_plan_chunk',
          buildPlanChunk: {
            relativePath: '.nemo/build-plans/plan-1.md',
            content: '# Build Plan: Draft\n',
          },
        }),
      ),
    ).toEqual({
      type: 'build_plan_chunk',
      buildPlanChunk: {
        relativePath: '.nemo/build-plans/plan-1.md',
        content: '# Build Plan: Draft\n',
      },
    });
  });

  it('parses build_plan_stream_end payloads', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'build_plan_stream_end',
          buildPlanStreamEnd: {
            relativePath: '.nemo/build-plans/plan-1.md',
          },
        }),
      ),
    ).toEqual({
      type: 'build_plan_stream_end',
      buildPlanStreamEnd: {
        relativePath: '.nemo/build-plans/plan-1.md',
      },
    });
  });
});
