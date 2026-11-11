import { TestBed } from '@angular/core/testing';
import {
  PINNED_OPENROUTER_PROVIDER_ID,
  defaultDependencyCatalog,
  type AppConfig,
  type DependencyInfo,
  type DependencyProgressEvent,
} from '@shared/index';
import { describe, expect, it, vi } from 'vitest';
import {
  CoreDependenciesStatusService,
  coreDependenciesNeeded,
  missingCoreDependencies,
  outdatedCoreDependencies,
} from './core-dependencies-status.service';
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

/** The catalog with llama-server installed from a build older than the pinned one. */
function outdatedLlama(): DependencyInfo[] {
  return catalog(['llama-server']).map((dep) =>
    dep.id === 'llama-server' ? { ...dep, version: 'b10867', updateAvailable: 'b12182' } : dep,
  );
}

describe('outdatedCoreDependencies', () => {
  it('lists an installed llama-server that a reinstall would update', () => {
    expect(outdatedCoreDependencies(outdatedLlama())).toEqual(['llama-server']);
    expect(outdatedCoreDependencies(catalog(['llama-server']))).toEqual([]);
  });

  it('ignores a build that is not installed', () => {
    const deps = outdatedLlama().map((dep) => ({ ...dep, state: 'updating' as const }));
    expect(outdatedCoreDependencies(deps)).toEqual([]);
  });
});

describe('coreDependenciesNeeded', () => {
  function config(activeLlmModelId: string): AppConfig {
    const source = (id: string, provider: string, modelId: string) => ({
      id,
      name: id,
      provider,
      baseUrl: '',
      models: [{ id: modelId, name: modelId, model: modelId }],
    });
    return {
      activeLlmModelId,
      llmProviders: [
        source('local-source', 'llamacpp', 'local-1'),
        source(PINNED_OPENROUTER_PROVIDER_ID, 'openrouter', 'remote-1'),
      ],
    } as unknown as AppConfig;
  }

  it('needs them for a managed local model or before a model is picked', () => {
    expect(coreDependenciesNeeded(null)).toBe(true);
    expect(coreDependenciesNeeded(config(''))).toBe(true);
    expect(coreDependenciesNeeded(config('local-1'))).toBe(true);
  });

  it('does not need them for a remote source', () => {
    expect(coreDependenciesNeeded(config('remote-1'))).toBe(false);
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

  it('flags an out-of-date core dep and clears it after the reinstall', async () => {
    const { service, electron, emitProgress } = setup(outdatedLlama());
    await settle();
    expect(service.hasMissing()).toBe(false);
    expect(service.outdatedSummary()).toBe('Update available: llama-server');

    electron.depsList.mockResolvedValue({ ok: true, dependencies: catalog(['llama-server']) });
    emitProgress({ depId: 'llama-server', phase: 'done' });
    await settle();
    expect(service.outdated()).toEqual([]);
    expect(service.outdatedSummary()).toBe('');
  });
});
