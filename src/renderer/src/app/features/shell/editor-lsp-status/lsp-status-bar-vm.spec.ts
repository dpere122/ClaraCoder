import { describe, expect, it } from 'vitest';
import type { LspDashboardStatus } from '@shared/index';
import { buildLspStatusBarVm } from './lsp-status-bar-vm';

function dashboard(partial: Partial<LspDashboardStatus['servers']> = {}): LspDashboardStatus {
  return {
    sessionId: 's1',
    servers: {
      python: { initialized: false, phase: 'idle' },
      typescript: { initialized: false, phase: 'idle' },
      gdscript: { initialized: false, phase: 'idle' },
      java: { initialized: false, phase: 'idle' },
      ...partial,
    },
  };
}

describe('buildLspStatusBarVm', () => {
  it('hides idle servers and shows LSP idle', () => {
    const vm = buildLspStatusBarVm(dashboard(), '', false);
    expect(vm.chips).toEqual([]);
    expect(vm.idleText).toBe('LSP idle');
    expect(vm.visible).toBe(true);
  });

  it('shows indexing and running chips only', () => {
    const vm = buildLspStatusBarVm(
      dashboard({
        python: { initialized: true, phase: 'running', scope: 'workspace' },
        java: { initialized: true, phase: 'indexing', languageStatus: 'Starting: Init' },
      }),
      '',
      false,
    );
    expect(vm.chips.map((chip) => chip.text)).toEqual(['Python · running', 'Java · indexing']);
    expect(vm.chips[0].tone).toBe('ok');
    expect(vm.chips[1].tone).toBe('pending');
    expect(vm.chips[1].title).toContain('Starting: Init');
  });

  it('shows shutting down with a pending tone', () => {
    const vm = buildLspStatusBarVm(
      dashboard({
        typescript: { initialized: false, phase: 'shuttingDown' },
      }),
      '',
      false,
    );
    expect(vm.chips).toHaveLength(1);
    expect(vm.chips[0].text).toBe('TS/JS · shutting down');
    expect(vm.chips[0].tone).toBe('pending');
  });

  it('shows crashed as an error chip', () => {
    const vm = buildLspStatusBarVm(
      dashboard({
        python: { initialized: false, phase: 'crashed' },
      }),
      '',
      false,
    );
    expect(vm.chips).toHaveLength(1);
    expect(vm.chips[0].text).toBe('Python · crashed');
    expect(vm.chips[0].tone).toBe('error');
  });

  it('surfaces fetch errors instead of idle', () => {
    const vm = buildLspStatusBarVm(null, 'backend down', false);
    expect(vm.chips).toHaveLength(1);
    expect(vm.chips[0].tone).toBe('error');
    expect(vm.chips[0].text).toContain('backend down');
    expect(vm.visible).toBe(true);
  });

  it('hides the indicator when the chat has no workspace', () => {
    const vm = buildLspStatusBarVm(null, '', false, null, false);
    expect(vm.visible).toBe(false);
    expect(vm.chips).toEqual([]);
  });

  it('hides instead of showing a no-workspace fetch error', () => {
    const vm = buildLspStatusBarVm(
      null,
      '{"detail":"This conversation does not have a workspace attached."}',
      false,
    );
    expect(vm.visible).toBe(false);
    expect(vm.chips).toEqual([]);
  });

  it('shows a starting chip while warming an idle server', () => {
    const vm = buildLspStatusBarVm(dashboard(), '', false, 'java');
    expect(vm.chips.map((chip) => chip.text)).toEqual(['Java · starting']);
    expect(vm.chips[0].tone).toBe('pending');
  });

  it('keeps dashboard initializing instead of overlaying starting', () => {
    const vm = buildLspStatusBarVm(
      dashboard({
        java: { initialized: false, phase: 'initializing' },
      }),
      '',
      false,
      'java',
    );
    expect(vm.chips.map((chip) => chip.text)).toEqual(['Java · initializing']);
  });

  it('puts initialize timeout text on a crashed chip title', () => {
    const vm = buildLspStatusBarVm(
      dashboard({
        java: {
          initialized: false,
          phase: 'crashed',
          lastError: "LSP request timed out for 'initialize' after 90.0s",
        },
      }),
      '',
      false,
    );
    expect(vm.chips[0].text).toBe('Java · crashed');
    expect(vm.chips[0].title).toContain('timed out');
  });
});
