import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { NEVER, Subject } from 'rxjs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDefaultContextCompression,
  SecretValue,
  type AppConfig,
  type ModelManagerFileEntry,
  type ModelManagerListModelsResult,
} from '@shared/index';
import type { AnthropicService as AnthropicServiceType } from '../../core/anthropic.service';
import type { ElectronService as ElectronServiceType } from '../../core/electron.service';
import type { ThemeEngineService as ThemeEngineServiceType } from '../../core/theme/theme-engine.service';
import { lucideAppProviders } from '../../lucide-setup';
import type { ThemedConfirmDialogService as ThemedConfirmDialogServiceType } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import type { ThemedPromptDialogService as ThemedPromptDialogServiceType } from '../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import type { Settings as SettingsComponent } from '../settings/settings/settings';
import type { SettingsStore as SettingsStoreType } from '../settings/settings/settings-store';
import type { SettingsThemesStore as SettingsThemesStoreType } from '../settings/settings-themes/settings-themes-store';

let AnthropicService!: typeof AnthropicServiceType;
let ElectronService!: typeof ElectronServiceType;
let ThemeEngineService!: typeof ThemeEngineServiceType;
let ThemedConfirmDialogService!: typeof ThemedConfirmDialogServiceType;
let ThemedPromptDialogService!: typeof ThemedPromptDialogServiceType;
let SettingsThemesStore!: typeof SettingsThemesStoreType;
let Settings!: typeof SettingsComponent;
let SettingsStore!: typeof SettingsStoreType;

const LOCAL_ID = 'local-source';
const MODEL: ModelManagerFileEntry = {
  fileName: 'model.gguf', absolutePath: '/models/model.gguf', sizeBytes: 1024, modifiedMs: 0, source: 'custom',
};

function initialConfig(): AppConfig {
  return {
    currentWorkspaceId: null,
    workspaces: [],
    themeId: 'clara-dark',
    activeLlmModelId: 'local-model-id',
    llmProviders: [{
      id: LOCAL_ID,
      name: 'Local Model',
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: SecretValue.of(''),
      models: [{
        id: 'local-model-id', name: 'Local', model: 'local-model', contextWindowTokens: 8192,
        thinkingMode: 'default', samplingPreset: 'provider-default', architectureHint: 'auto',
        temperature: 0, parallelToolCalls: true, optimizationPreset: 'generic', maxOutputTokens: 0,
        llamaCppManaged: { chatRunCommand: 'llama-server --port {{PORT}}', embeddingRunCommand: '' },
      }],
    }],
    audioTranscription: { provider: 'disabled', baseUrl: '', model: '', apiKey: SecretValue.of('') },
    workspaceTools: {
      editToolsMode: 'standard', maxFileReadLines: 400, maxSearchResults: 40,
      defaultWorkspaceEncoding: 'utf-8', defaultWorkspaceNewline: 'lf', allowStagingOverlayCommands: false,
      exposeAllWorkspaceFiles: false, allowWebAccess: false, searxngBaseUrl: '', webSearchProvider: 'auto',
      extraUserPath: '', enableAgentFormatters: false,
    },
    mcpServers: [],
    contextCompression: getDefaultContextCompression(),
    healthMonitor: { logLevel: 'info', metricsEnabled: false },
    modelManager: { customModelsDir: '', huggingFaceToken: SecretValue.of('') },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function setup() {
  let disk = structuredClone(initialConfig());
  const electron = {
    settingsSelectTab$: new Subject<string>(),
    config$: new Subject<AppConfig>(),
    hfDownloadProgress$: new Subject(),
    chatTemplateReasoning$: new Subject(),
    llamaServerNctx$: new Subject(),
    llamaServerLifecycle$: new Subject(),
    notifySettingsWindowReady: vi.fn(),
    loadConfig: vi.fn(async () => structuredClone(disk)),
    saveConfig: vi.fn(async (next: AppConfig): Promise<AppConfig> => {
      disk = structuredClone(next);
      return structuredClone(disk);
    }),
    closeSettingsWindow: vi.fn(),
    listSystemFonts: vi.fn(async () => []),
    listCudaGpus: vi.fn(async () => []),
    depsList: vi.fn(async () => ({ dependencies: [] })),
    llamacppManagedListModels: vi.fn(async () => ({ ok: true as const, models: [] })),
    modelManagerListCustomModels: vi.fn(async (_payload: { customDir: string }): Promise<ModelManagerListModelsResult> => ({ ok: true, models: [] })),
    refreshChatTemplateReasoning: vi.fn(async () => undefined),
    llamaServerFlagCatalog: vi.fn(async () => ({ ok: false as const, error: 'not installed' })),
    llamaServerLaunchedCommand: vi.fn(async () => ({ ok: true as const, command: null })),
    llamaServerVramUsage: vi.fn(async () => []),
    llamaServerGgufSize: vi.fn(async () => null),
    llamaServerGgufProfile: vi.fn(async () => null),
    llamaServerTotalRam: vi.fn(async () => null),
    modelManagerDownloadHfFile: vi.fn(),
  };
  const confirm = { active: signal(null), open: vi.fn(async () => 'confirm') };
  TestBed.configureTestingModule({
    imports: [Settings],
    providers: [
      ...lucideAppProviders,
      { provide: ElectronService, useValue: electron },
      { provide: AnthropicService, useValue: {} },
      { provide: ThemedConfirmDialogService, useValue: confirm },
      { provide: ThemedPromptDialogService, useValue: { active: signal(null) } },
      { provide: NgxSpinnerService, useValue: { getSpinner: () => NEVER, show: vi.fn(), hide: vi.fn() } },
      { provide: ThemeEngineService, useValue: { library: signal([]) } },
      {
        provide: SettingsThemesStore,
        useValue: {
          attach: vi.fn(), syncSelectionFromHost: vi.fn(), cancelPreview: vi.fn(),
          persistIfDirty: vi.fn(async () => undefined), afterPersist: vi.fn(),
        },
      },
    ],
  });
  async function mount() {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();
    await flush(fixture);
    return { fixture, store: fixture.debugElement.injector.get(SettingsStore), host: fixture.nativeElement as HTMLElement };
  }
  return {
    electron,
    confirm,
    mount,
    saved: () => structuredClone(disk),
    broadcastSaved: (next: AppConfig) => {
      disk = structuredClone(next);
      electron.config$.next(structuredClone(disk));
    },
  };
}

async function flush(fixture: ComponentFixture<SettingsComponent>): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  fixture.detectChanges();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  fixture.detectChanges();
}

function target(host: HTMLElement, name: string): HTMLElement {
  const matches = host.querySelectorAll<HTMLElement>(`[data-tutorial="${name}"]`);
  expect(matches, `expected one ${name} target`).toHaveLength(1);
  return matches[0]!;
}

function state(host: HTMLElement, name: string): string | null {
  return target(host, 'settings-sources-nav').getAttribute(`data-tutorial-${name}`);
}

function sourceRow(host: HTMLElement, id: string): HTMLElement | null {
  return [...host.querySelectorAll<HTMLElement>('[data-tutorial-source-row]')]
    .find((row) => row.getAttribute('data-tutorial-source-id') === id) ?? null;
}

beforeAll(async () => {
  // Another suite may already have loaded a chunk before its lazy imports initialized.
  // Start a fresh module graph, then initialize dependencies before component class fields.
  vi.resetModules();
  await import('@shared/index');
  await import('@shared/theme');
  await import('../settings/settings/settings-tabs');
  // Provider tokens must come from the same fresh graph as Settings and its store.
  ({ ElectronService } = await import('../../core/electron.service'));
  ({ AnthropicService } = await import('../../core/anthropic.service'));
  ({ ThemedConfirmDialogService } = await import('../../shared/themed-confirm-dialog/themed-confirm-dialog.service'));
  ({ ThemedPromptDialogService } = await import('../../shared/themed-prompt-dialog/themed-prompt-dialog.service'));
  ({ ThemeEngineService } = await import('../../core/theme/theme-engine.service'));
  ({ SettingsThemesStore } = await import('../settings/settings-themes/settings-themes-store'));
  ({ SettingsStore } = await import('../settings/settings/settings-store'));
  ({ Settings } = await import('../settings/settings/settings'));
});

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => TestBed.resetTestingModule());

describe('local source tutorial targets', () => {
  it('observes a new source as a draft until the user clicks Apply, without changing it on tutorial events', async () => {
    const h = setup();
    const { fixture, store, host } = await h.mount();
    const useCustom = vi.spyOn(store, 'useCustomModelInModels');
    const useHf = vi.spyOn(store, 'useHfModelInModels');
    const add = vi.spyOn(store, 'addProvider');
    const before = structuredClone(store.llmProviders());
    const active = store.activeLlmModelId();

    expect(state(host, 'source-id')).toBe(LOCAL_ID);
    expect(state(host, 'source-state')).toBe('persisted');
    expect(state(host, 'source-kind')).toBe('managed-local');
    expect(state(host, 'settings-dirty')).toBe('false');
    expect(state(host, 'models-state')).toBe('empty');
    expect(target(host, 'settings-apply').tagName).toBe('P');
    expect(target(host, 'sources-local-model').querySelector('.pill-select__trigger')).not.toBeNull();
    expect(target(host, 'sources-defaults').textContent).toContain('Ready defaults');
    expect(target(host, 'sources-advanced').tagName).toBe('SUMMARY');

    for (const stepId of ['sources-navigation', 'sources-lm-studio', 'sources-custom-endpoint', 'sources-openrouter', 'sources-claude', 'sources-add', 'sources-model', 'sources-defaults', 'sources-advanced', 'sources-apply']) {
      window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'local-source', stepId } }));
    }
    await flush(fixture);
    expect(store.llmProviders()).toEqual(before);
    expect(store.activeLlmModelId()).toBe(active);
    expect(add).not.toHaveBeenCalled();
    expect(useCustom).not.toHaveBeenCalled();
    expect(useHf).not.toHaveBeenCalled();
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
    expect(h.electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();

    (target(host, 'sources-add') as HTMLButtonElement).click();
    await flush(fixture);
    const id = state(host, 'source-id')!;
    expect(id).not.toBe(LOCAL_ID);
    expect(state(host, 'source-state')).toBe('draft');
    expect(state(host, 'settings-dirty')).toBe('true');
    // The default -hf example does not make a downloaded-model inventory ready.
    expect(state(host, 'models-state')).toBe('empty');
    expect(state(host, 'model-selected')).toBe('false');
    expect(sourceRow(host, id)?.getAttribute('data-tutorial-source-state')).toBe('draft');
    expect(h.saved().llmProviders.some((source) => source.id === id)).toBe(false);
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
    expect(store.activeLlmModelId()).toBe(active);

    target(host, 'sources-advanced').click();
    await flush(fixture);
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
    expect(useCustom).not.toHaveBeenCalled();
    expect(useHf).not.toHaveBeenCalled();
    expect(target(host, 'settings-apply').tagName).toBe('BUTTON');
    (target(host, 'settings-apply') as HTMLButtonElement).click();
    await flush(fixture);
    expect(h.electron.saveConfig).toHaveBeenCalledTimes(1);
    expect(h.saved().llmProviders.some((source) => source.id === id)).toBe(true);
    expect(state(host, 'source-state')).toBe('persisted');
    expect(state(host, 'settings-dirty')).toBe('false');
    expect(sourceRow(host, id)?.getAttribute('data-tutorial-source-state')).toBe('persisted');
    expect(target(host, 'settings-apply').tagName).toBe('P');
  });

  it('lets a coordinator detect a discarded draft after Settings closes, without silently recreating it', async () => {
    const h = setup();
    const first = await h.mount();
    (target(first.host, 'sources-add') as HTMLButtonElement).click();
    await flush(first.fixture);
    const draftId = state(first.host, 'source-id')!;
    expect(state(first.host, 'source-state')).toBe('draft');
    (first.host.querySelector('.settings-top-bar__close') as HTMLButtonElement).click();
    await flush(first.fixture);
    expect(h.confirm.open).toHaveBeenCalledTimes(1);
    expect(h.electron.closeSettingsWindow).toHaveBeenCalledTimes(1);
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
    first.fixture.destroy();

    const reopened = await h.mount();
    expect(state(reopened.host, 'source-id')).toBe(LOCAL_ID);
    expect(state(reopened.host, 'source-state')).toBe('persisted');
    expect(state(reopened.host, 'settings-dirty')).toBe('false');
    expect(sourceRow(reopened.host, draftId)).toBeNull();
    expect(reopened.store.llmProviders()).toHaveLength(1);
    expect(h.electron.saveConfig).not.toHaveBeenCalled();

    (target(reopened.host, 'sources-add') as HTMLButtonElement).click();
    await flush(reopened.fixture);
    expect(state(reopened.host, 'source-id')).not.toBe(draftId);
    expect(state(reopened.host, 'source-state')).toBe('draft');
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
  });

  it('keeps the applied source discoverable after reopen even if another source is selected', async () => {
    const h = setup();
    const first = await h.mount();
    (target(first.host, 'sources-add') as HTMLButtonElement).click();
    await flush(first.fixture);
    const id = state(first.host, 'source-id')!;
    (target(first.host, 'settings-apply') as HTMLButtonElement).click();
    await flush(first.fixture);
    first.fixture.destroy();

    const reopened = await h.mount();
    expect(state(reopened.host, 'source-id')).toBe(LOCAL_ID);
    const row = sourceRow(reopened.host, id);
    expect(row?.getAttribute('data-tutorial-source-state')).toBe('persisted');
    expect(row?.getAttribute('data-tutorial-source-selected')).toBe('false');
    (row!.querySelector('.source-row') as HTMLButtonElement).click();
    await flush(reopened.fixture);
    expect(state(reopened.host, 'source-id')).toBe(id);
    expect(state(reopened.host, 'source-state')).toBe('persisted');
    expect(state(reopened.host, 'settings-dirty')).toBe('false');
    expect(h.electron.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('reports an existing source as persisted while separately exposing unapplied edits', async () => {
    const h = setup();
    const { fixture, host } = await h.mount();
    const name = host.querySelector<HTMLInputElement>('.model-run-hero input[type="text"]')!;
    name.value = 'My edited source';
    name.dispatchEvent(new Event('input'));
    await flush(fixture);
    expect(state(host, 'source-state')).toBe('persisted');
    expect(state(host, 'settings-dirty')).toBe('true');
    expect(h.saved().llmProviders[0]?.customName).not.toBe('My edited source');
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
    (target(host, 'settings-apply') as HTMLButtonElement).click();
    await flush(fixture);
    expect(h.saved().llmProviders[0]?.customName).toBe('My edited source');
    expect(state(host, 'settings-dirty')).toBe('false');
  });

  it('tracks persisted identities from broadcasts without overwriting a dirty source draft', async () => {
    const h = setup();
    const { fixture, store, host } = await h.mount();
    (target(host, 'sources-add') as HTMLButtonElement).click();
    await flush(fixture);
    const id = state(host, 'source-id')!;
    const external = h.saved();
    external.llmProviders.push(structuredClone(store.selectedProvider()!));
    store.updateSelectedProvider({ customName: 'Local draft edit' });
    h.broadcastSaved(external);
    await flush(fixture);
    expect(state(host, 'source-id')).toBe(id);
    expect(state(host, 'source-state')).toBe('persisted');
    expect(state(host, 'settings-dirty')).toBe('true');
    expect(store.selectedProvider()?.customName).toBe('Local draft edit');
    expect(h.electron.saveConfig).not.toHaveBeenCalled();

    external.llmProviders = external.llmProviders.filter((provider) => provider.id !== id);
    h.broadcastSaved(external);
    await flush(fixture);
    expect(state(host, 'source-state')).toBe('draft');
    expect(store.selectedProvider()?.customName).toBe('Local draft edit');
  });

  it('keeps a draft dirty and unpersisted if the user-initiated save fails', async () => {
    const h = setup();
    const { fixture, store, host } = await h.mount();
    (target(host, 'sources-add') as HTMLButtonElement).click();
    await flush(fixture);
    const id = state(host, 'source-id');
    h.electron.saveConfig.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.applySettings()).rejects.toThrow('disk full');
    await flush(fixture);
    expect(state(host, 'settings-saving')).toBe('false');
    expect(state(host, 'settings-dirty')).toBe('true');
    expect(state(host, 'source-state')).toBe('draft');
    expect(h.saved().llmProviders.some((provider) => provider.id === id)).toBe(false);
  });

  it('does not mark a source added during an in-flight Apply as persisted', async () => {
    const h = setup();
    const { fixture, host } = await h.mount();
    const save = deferred<AppConfig>();
    h.electron.saveConfig.mockImplementationOnce(() => save.promise);
    (target(host, 'sources-add') as HTMLButtonElement).click();
    await flush(fixture);
    const firstId = state(host, 'source-id')!;
    (target(host, 'settings-apply') as HTMLButtonElement).click();
    await flush(fixture);
    expect(state(host, 'settings-saving')).toBe('true');
    expect(state(host, 'source-state')).toBe('draft');
    const saved = structuredClone(h.electron.saveConfig.mock.calls[0]![0]);

    (target(host, 'sources-add') as HTMLButtonElement).click();
    await flush(fixture);
    const secondId = state(host, 'source-id')!;
    expect(secondId).not.toBe(firstId);
    save.resolve(saved);
    await flush(fixture);
    expect(state(host, 'settings-saving')).toBe('false');
    expect(state(host, 'settings-dirty')).toBe('true');
    expect(state(host, 'source-state')).toBe('draft');
    expect(sourceRow(host, firstId)?.getAttribute('data-tutorial-source-state')).toBe('persisted');
    expect(sourceRow(host, secondId)?.getAttribute('data-tutorial-source-state')).toBe('draft');
    (target(host, 'settings-apply') as HTMLButtonElement).click();
    await flush(fixture);
    expect(state(host, 'source-state')).toBe('persisted');
    expect(state(host, 'settings-dirty')).toBe('false');
    expect(h.electron.saveConfig).toHaveBeenCalledTimes(2);
  });

  it('distinguishes inventory loading, empty, ready and error, and only selects a model on a click', async () => {
    const h = setup();
    const { fixture, store, host } = await h.mount();
    (target(host, 'sources-add') as HTMLButtonElement).click();
    await flush(fixture);
    const sourceId = state(host, 'source-id');
    const useCustom = vi.spyOn(store, 'useCustomModelInModels');
    const useHf = vi.spyOn(store, 'useHfModelInModels');
    const list = deferred<ModelManagerListModelsResult>();
    h.electron.modelManagerListCustomModels.mockReturnValueOnce(list.promise);
    store.modelManagerCustomDir.set('/models');
    const loading = store.refreshCustomModelCards();
    await flush(fixture);
    expect(state(host, 'models-state')).toBe('loading');
    expect(target(host, 'sources-local-model').getAttribute('data-tutorial-models-state')).toBe('loading');
    list.resolve({ ok: true, models: [
      { ...MODEL, fileName: 'mtp-model.gguf', absolutePath: '/models/mtp-model.gguf' },
      { ...MODEL, fileName: 'mmproj-model.gguf', absolutePath: '/models/mmproj-model.gguf' },
    ] });
    await loading;
    await flush(fixture);
    expect(state(host, 'models-state')).toBe('empty');
    expect(state(host, 'model-selected')).toBe('false');

    h.electron.modelManagerListCustomModels.mockResolvedValueOnce({ ok: true, models: [MODEL] });
    await store.refreshCustomModelCards();
    await flush(fixture);
    expect(state(host, 'models-state')).toBe('ready');
    expect(state(host, 'model-selected')).toBe('false');
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
    const picker = target(host, 'sources-local-model');
    (picker.querySelector('.pill-select__trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    const option = [...picker.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent?.includes(MODEL.fileName));
    expect(option).toBeDefined();
    option!.click();
    await flush(fixture);
    expect(state(host, 'model-selected')).toBe('true');
    expect(state(host, 'source-id')).toBe(sourceId);
    expect(store.selectedLlamaCppManaged().chatRunCommand).toContain(MODEL.absolutePath);
    expect(h.electron.saveConfig).not.toHaveBeenCalled();
    expect(useCustom).not.toHaveBeenCalled();
    expect(useHf).not.toHaveBeenCalled();

    h.electron.modelManagerListCustomModels.mockResolvedValueOnce({ ok: false, error: 'read failed' });
    await store.refreshCustomModelCards();
    await flush(fixture);
    expect(state(host, 'models-state')).toBe('error');
    expect(target(host, 'sources-local-model').getAttribute('data-tutorial-models-state')).toBe('error');
  });
});
