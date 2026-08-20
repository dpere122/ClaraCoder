import { describe, expect, it } from 'vitest';
import type { LspDashboardStatus } from '@shared/index';
import { needsEnvPoll, needsLifecyclePoll } from './lsp-env-poll-policy';

function dashboard(partial: Partial<LspDashboardStatus> = {}): LspDashboardStatus {
  return {
    sessionId: 's1',
    servers: {
      python: { initialized: false, phase: 'idle' },
      typescript: { initialized: false, phase: 'idle' },
      gdscript: { initialized: false, phase: 'idle' },
      java: { initialized: false, phase: 'idle' },
    },
    ...partial,
  };
}

describe('needsLifecyclePoll', () => {
  it('is false when every server is idle or running', () => {
    expect(needsLifecyclePoll(dashboard())).toBe(false);
    expect(
      needsLifecyclePoll(
        dashboard({
          servers: {
            python: { initialized: true, phase: 'running' },
            typescript: { initialized: false, phase: 'idle' },
            gdscript: { initialized: false, phase: 'idle' },
            java: { initialized: false, phase: 'idle' },
          },
        }),
      ),
    ).toBe(false);
  });

  it('is true for starting, indexing, and shutting down', () => {
    expect(
      needsLifecyclePoll(
        dashboard({
          servers: {
            python: { initialized: false, phase: 'starting' },
            typescript: { initialized: false, phase: 'idle' },
            gdscript: { initialized: false, phase: 'idle' },
            java: { initialized: false, phase: 'idle' },
          },
        }),
      ),
    ).toBe(true);
    expect(
      needsLifecyclePoll(
        dashboard({
          servers: {
            python: { initialized: false, phase: 'idle' },
            typescript: { initialized: false, phase: 'idle' },
            gdscript: { initialized: false, phase: 'idle' },
            java: { initialized: true, phase: 'indexing' },
          },
        }),
      ),
    ).toBe(true);
    expect(
      needsLifecyclePoll(
        dashboard({
          servers: {
            python: { initialized: false, phase: 'idle' },
            typescript: { initialized: false, phase: 'shuttingDown' },
            gdscript: { initialized: false, phase: 'idle' },
            java: { initialized: false, phase: 'idle' },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('needsEnvPoll', () => {
  it('still waits for a python venv on a .py tab', () => {
    expect(needsEnvPoll(dashboard({ pythonEnvironmentPath: null }), 'src/app.py')).toBe(true);
    expect(needsEnvPoll(dashboard({ pythonEnvironmentPath: '/ws/.venv' }), 'src/app.py')).toBe(false);
  });
});
