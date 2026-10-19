import { describe, expect, it } from 'vitest';
import type { DependencyInfo, RuntimeHealthSnapshot } from '@shared/index';
import { buildRuntimeChips, runtimeVerdict } from './health-runtime';

function dep(partial: Partial<DependencyInfo> & Pick<DependencyInfo, 'id' | 'state'>): DependencyInfo {
  return {
    label: partial.id,
    description: '',
    version: null,
    path: null,
    sizeHint: '',
    canDelete: false,
    ...partial,
  };
}

function snap(overrides: Partial<RuntimeHealthSnapshot> = {}): RuntimeHealthSnapshot {
  return {
    timestampMs: 0,
    python: { healthy: true },
    dependencies: [dep({ id: 'llama-server', state: 'installed', version: 'b5000' })],
    llama: { binaryInstalled: true, runningCount: 0, health: 'stopped' },
    lsp: { javaInstalled: false, vtslsInstalled: true, activeSessions: 0 },
    ...overrides,
  };
}

describe('buildRuntimeChips', () => {
  it('lists python, dependencies, llama runtime, and LSP in order', () => {
    const chips = buildRuntimeChips(snap());
    expect(chips.map((c) => c.key)).toEqual(['python', 'llama-server', 'llama-runtime', 'lsp']);
    expect(chips[1]).toMatchObject({ label: 'llama-server', detail: 'vb5000', tone: 'ok' });
    expect(chips[3]).toMatchObject({ detail: 'TS/JS ready', tone: 'ok' });
  });

  it('clips dependency errors in detail but keeps the full text as hint', () => {
    const error = 'x'.repeat(80);
    const chip = buildRuntimeChips(snap({ dependencies: [dep({ id: 'whisper', state: 'error', error })] }))[1]!;
    expect(chip.tone).toBe('error');
    expect(chip.detail).toHaveLength(48);
    expect(chip.hint).toBe(error);
  });

  it('flags a running but unhealthy llama server as a warning', () => {
    const chips = buildRuntimeChips(snap({ llama: { binaryInstalled: true, runningCount: 2, health: 'loading' } }));
    expect(chips.find((c) => c.key === 'llama-runtime')).toMatchObject({ detail: '2 running · loading', tone: 'warn' });
  });
});

describe('runtimeVerdict', () => {
  it('reports checking before the first snapshot', () => {
    expect(runtimeVerdict([], false, false)).toMatchObject({ tone: 'muted', issues: 0 });
  });

  it('reports the sidecar as unreachable when the snapshot failed', () => {
    expect(runtimeVerdict([], true, true)).toMatchObject({ tone: 'error', title: 'Sidecar unreachable', issues: 1 });
  });

  it('treats missing optional pieces as healthy', () => {
    const chips = buildRuntimeChips(snap({ dependencies: [dep({ id: 'kokoro', state: 'missing' })] }));
    expect(runtimeVerdict(chips, false, true)).toMatchObject({ tone: 'ok', title: 'All systems OK', issues: 0 });
  });

  it('counts warnings and errors and escalates to the worst tone', () => {
    const chips = buildRuntimeChips(
      snap({
        python: { healthy: false },
        llama: { binaryInstalled: true, runningCount: 1, health: 'loading' },
      }),
    );
    const v = runtimeVerdict(chips, false, true);
    expect(v).toMatchObject({ tone: 'error', title: '2 issues', issues: 2 });
    expect(v.detail).toContain('Python: sidecar down');
  });
});
