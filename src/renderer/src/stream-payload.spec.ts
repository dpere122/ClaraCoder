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

  it('parses harness_crystal payloads', () => {
    expect(parseAgentStreamPayload(JSON.stringify({ type: 'harness_crystal', polarity: 'positive' }))).toEqual({
      type: 'harness_crystal',
      polarity: 'positive',
    });
    expect(parseAgentStreamPayload(JSON.stringify({ type: 'harness_crystal', polarity: 'negative' }))).toEqual({
      type: 'harness_crystal',
      polarity: 'negative',
    });
  });

  it('parses tool execution chunks with optional label and stream tag', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_chunk',
          delta: '1 passed\n',
          stream_tag: 'spec-code_review-tests',
          label: 'Pytest',
        }),
      ),
    ).toEqual({
      type: 'tool_exec_chunk',
      delta: '1 passed\n',
      streamTag: 'spec-code_review-tests',
      label: 'Pytest',
    });
  });

  it('parses tool_exec_complete with outcome', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'spec-project_review-smoke',
          exit_code: -15,
          outcome: 'passed',
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'spec-project_review-smoke',
      exitCode: -15,
      outcome: 'passed',
    });
  });

  it('parses tool_exec_complete with exit_code', () => {
    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'spec-project_review-tests',
          label: 'Workspace Pytest',
          exit_code: 0,
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'spec-project_review-tests',
      label: 'Workspace Pytest',
      exitCode: 0,
    });

    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'spec-project_review-tests',
          exit_code: null,
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'spec-project_review-tests',
      exitCode: null,
    });

    expect(
      parseAgentStreamPayload(
        JSON.stringify({
          type: 'tool_exec_complete',
          stream_tag: 'spec-project_review-smoke',
          exit_code: 1,
          output_excerpt: 'Traceback (most recent call last):',
        }),
      ),
    ).toEqual({
      type: 'tool_exec_complete',
      streamTag: 'spec-project_review-smoke',
      exitCode: 1,
      outputExcerpt: 'Traceback (most recent call last):',
    });
  });

  it('parses review payload variants without falling back to plain chunks', () => {
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
});
