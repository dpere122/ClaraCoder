import { TestBed } from '@angular/core/testing';
import { defaultDependencyCatalog, type DependencyInfo, type DependencyProgressEvent } from '@shared/index';
import { describe, expect, it, vi } from 'vitest';
import { CoreDependenciesStatusService, missingCoreDependencies } from './core-dependencies-status.service';
import { ElectronService } from './electron.service';

function catalog(installed: readonly string[]): DependencyInfo[] {
  return defaultDependencyCatalog().map((dep) =>
    installed.includes(dep.id) ? { ...dep, state: 'installed' as const } : dep,
  );
}

/** Lets the startup check (or any pending one) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

function setup(deps: DependencyInfo[]) {
  let progress: ((event: DependencyProgressEvent) => void) | null = null;
  const electron = {
    isElectron: true,
    depsList: vi.fn(async () => ({ ok: true, dependencies: deps })),
    onDepsProgress: vi.fn((cb: (event: DependencyProgressEvent) => void) => {
      progress = cb;
      return () => undefined;
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ElectronService, useValue: electron }] });
  const service = TestBed.inject(CoreDependenciesStatusService);
  return { service, electron, emitProgress: (event: DependencyProgressEvent) => progress?.(event) };
}

describe('missingCoreDependencies', () => {
  it('lists only llama-server when it is missing', () => {
    expect(missingCoreDependencies(catalog([]))).toEqual(['llama-server']);
    expect(missingCoreDependencies(catalog(['java-lsp']))).toEqual(['llama-server']);
    expect(missingCoreDependencies(catalog(['llama-server']))).toEqual([]);
  });

  it('ignores updating and error states', () => {
    const deps = catalog([]).map((dep) =>
      dep.id === 'llama-server' ? { ...dep, state: 'updating' as const } : { ...dep, state: 'error' as const },
    );
    expect(missingCoreDependencies(deps)).toEqual([]);
  });
});

describe('CoreDependenciesStatusService', () => {
  it('flags missing core deps on startup with a summary naming them', async () => {
    const { service } = setup(catalog(['java-lsp']));
    await settle();
    expect(service.hasMissing()).toBe(true);
    expect(service.missingSummary()).toBe('Not downloaded: llama-server');
  });

  it('clears the flag after an install finishes', async () => {
    const deps = catalog(['java-lsp']);
    const { service, electron, emitProgress } = setup(deps);
    await settle();
    expect(service.missing()).toEqual(['llama-server']);

    electron.depsList.mockResolvedValue({ ok: true, dependencies: catalog(['java-lsp', 'llama-server']) });
    emitProgress({ depId: 'llama-server', phase: 'downloading' });
    expect(electron.depsList).toHaveBeenCalledTimes(1);
    emitProgress({ depId: 'llama-server', phase: 'done' });
    await settle();
    expect(electron.depsList).toHaveBeenCalledTimes(2);
    expect(service.hasMissing()).toBe(false);
    expect(service.missingSummary()).toBe('');
  });

  it('re-reads when an install finishes during an in-flight check', async () => {
    const { service, electron, emitProgress } = setup(catalog(['java-lsp']));
    await settle();

    let releaseStale!: () => void;
    electron.depsList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = () => resolve({ ok: true, dependencies: catalog(['java-lsp']) });
        }),
    );
    electron.depsList.mockResolvedValue({ ok: true, dependencies: catalog(['java-lsp', 'llama-server']) });
    const pending = service.refresh();
    emitProgress({ depId: 'llama-server', phase: 'done' });
    releaseStale();
    await pending;
    expect(electron.depsList).toHaveBeenCalledTimes(3);
    expect(service.hasMissing()).toBe(false);
  });
});
