import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { NEVER, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND,
  LLM_OPTIMIZATION_PRESET_LIST,
  PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
  type LlmProviderConfig,
  type ModelManagerListModelsResult,
} from '@shared/index';
import { AnthropicService } from '../../../core/anthropic.service';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { lucideAppProviders } from '../../../lucide-setup';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedPromptDialogService } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import { tutorialStepFor } from '../../tutorial/tutorial-steps';
import { SettingsStore } from '../settings/settings-store';
import { SettingsThemesStore } from '../settings-themes/settings-themes-store';
import { SettingsModels } from './settings-models';

function setup(provider: LlmProviderConfig['provider'] = 'lmstudio') {
  TestBed.configureTestingModule({
    imports: [SettingsModels],
    providers: [
      ...lucideAppProviders,
      SettingsStore,
      {
        provide: ElectronService,
        useValue: {
          chatTemplateReasoning$: new Subject(),
          llamaServerNctx$: new Subject(),
          llamaServerLifecycle$: new Subject(),
          refreshChatTemplateReasoning: vi.fn(async () => undefined),
          llamaServerFlagCatalog: vi.fn(async () => ({ ok: false, error: 'not installed' })),
          llamaServerLaunchedCommand: vi.fn(async () => ({ ok: true, command: null })),
          llamaServerVramUsage: vi.fn(async () => []),
          llamaServerTotalRam: vi.fn(async () => null),
          llamaServerGgufSize: vi.fn(async () => null),
          llamaServerGgufProfile: vi.fn(async () => null),
          modelManagerListCustomModels: vi.fn(async (): Promise<ModelManagerListModelsResult> => ({ ok: true, models: [] })),
          modelManagerSecretStorage: vi.fn(async () => 'keychain'),
          modelManagerDownloadHfFile: vi.fn(),
          saveConfig: vi.fn(),
        },
      },
      { provide: AnthropicService, useValue: {} },
      { provide: ThemedConfirmDialogService, useValue: { open: vi.fn(async () => 'cancel') } },
      { provide: ThemedPromptDialogService, useValue: {} },
      { provide: NgxSpinnerService, useValue: { getSpinner: () => NEVER, show: vi.fn(), hide: vi.fn() } },
      { provide: ThemeEngineService, useValue: { library: signal([]) } },
      { provide: SettingsThemesStore, useValue: { attach: vi.fn(), syncSelectionFromHost: vi.fn(), cancelPreview: vi.fn() } },
    ],
  });
  const store = TestBed.inject(SettingsStore);
  store.llmProviders.set([
    {
      id: 'lm',
      name: 'Server',
      provider,
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: {},
      models: [{ id: 'm1', name: 'model', model: 'model', contextWindowTokens: 8192, maxOutputTokens: 0 }],
    } as unknown as LlmProviderConfig,
  ]);
  store.selectedModelId.set('m1');
  return TestBed.createComponent(SettingsModels);
}

beforeEach(() => TestBed.resetTestingModule());

describe('Max output', () => {
  const TEXT = '0 uses the default limit. On llama.cpp and LM Studio that is 24,576 tokens per reply. Any other value replaces it.';

  it('says what 0 does on a local server, in the tooltip and to a screen reader', () => {
    const fixture = setup('llamacpp');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const help = [...el.querySelectorAll('.field-help')].find((h) => h.parentElement?.textContent?.includes('Max output'));
    expect(help?.getAttribute('aria-label')).toBe(TEXT);
    expect(help?.querySelector('[role="tooltip"]')?.textContent).toBe(TEXT);
    expect(el.querySelector<HTMLInputElement>('input[max="200000"]')?.placeholder).toBe('0 = default limit');
  });

  it('is described the same way by the Gemma template', () => {
    const gemma = LLM_OPTIMIZATION_PRESET_LIST.find((p) => p.id === 'gemma');
    expect(gemma?.description).toContain('max output 0 means a limit of 24576 tokens per reply');
    expect(gemma?.description).not.toContain('no Clara-side cap');
    expect(gemma?.providers).toEqual(['lmstudio', 'llamacpp', 'openai-compatible']);
  });
});

function llamaSource(id: string): LlmProviderConfig {
  return {
    id,
    name: 'Local model',
    provider: 'llamacpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: {},
    models: [{
      id: 'llama-model', name: 'model', model: 'model', contextWindowTokens: 8192, maxOutputTokens: 0,
      llamaCppManaged: { chatRunCommand: DEFAULT_MANAGED_LLAMA_CHAT_RUN_COMMAND, embeddingRunCommand: '' },
    }],
  } as unknown as LlmProviderConfig;
}

function target(host: HTMLElement, name: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-tutorial="${name}"]`);
}

describe('the sources list', () => {
  const rowIdsAroundSeparator = (host: HTMLElement) => {
    const children = Array.from(host.querySelector('.sources-list')!.children) as HTMLElement[];
    const at = children.findIndex((el) => el.matches('.sources-list__separator'));
    const ids = (rows: HTMLElement[]) => rows.map((el) => el.dataset['tutorialSourceId']);
    return at < 0 ? null : { before: ids(children.slice(0, at)), after: ids(children.slice(at + 1)) };
  };
  const other = (id: string) => ({ ...llamaSource(id), provider: 'openai', models: [] }) as LlmProviderConfig;

  it('sets local models apart below every other provider', () => {
    const fixture = setup();
    const store = TestBed.inject(SettingsStore);
    store.llmProviders.set([llamaSource('local-a'), other('other-a'), llamaSource('local-b'), other(PINNED_LLAMA_SERVER_URL_PROVIDER_ID)]);
    fixture.detectChanges();
    expect(rowIdsAroundSeparator(fixture.nativeElement)).toEqual({
      before: [PINNED_LLAMA_SERVER_URL_PROVIDER_ID, 'other-a'],
      after: ['local-a', 'local-b'],
    });
  });

  it.each([
    ['no local models', ['other-a'], []],
    ['only local models', [], ['local-a']],
  ])('has no separator with %s', (_name, others, locals) => {
    const fixture = setup();
    TestBed.inject(SettingsStore).llmProviders.set([...others.map(other), ...locals.map(llamaSource)]);
    fixture.detectChanges();
    expect(rowIdsAroundSeparator(fixture.nativeElement)).toBeNull();
  });
});

describe('the source radio', () => {
  const source = (id: string) =>
    ({ ...llamaSource(id), provider: 'openai', models: [{ ...llamaSource(id).models[0]!, id: `${id}-model` }] }) as LlmProviderConfig;

  function twoSources() {
    const fixture = setup();
    const store = TestBed.inject(SettingsStore);
    store.llmProviders.set([source('a'), source('b')]);
    store.selectedModelId.set('a-model');
    store.activeLlmModelId.set('a-model');
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const radio = (id: string) =>
      host.querySelector<HTMLInputElement>(`[data-tutorial-source-id="${id}"] input[type="radio"]`)!;
    return { fixture, store, radio };
  }

  it('selects the source as well as activating it', () => {
    const { store, radio } = twoSources();
    radio('b').click();
    expect(store.activeLlmModelId()).toBe('b-model');
    expect(store.selectedModelId()).toBe('b-model');
  });

  it('selects the source when it is already the active one', () => {
    const { fixture, store, radio } = twoSources();
    store.selectedModelId.set('b-model');
    fixture.detectChanges();
    radio('a').click();
    expect(store.activeLlmModelId()).toBe('a-model');
    expect(store.selectedModelId()).toBe('a-model');
  });

  it('leaves the active source alone when a row is only selected', () => {
    const { fixture, store } = twoSources();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[data-tutorial-source-id="b"] .source-row')!.click();
    expect(store.selectedModelId()).toBe('b-model');
    expect(store.activeLlmModelId()).toBe('a-model');
  });
});

describe('removing a source', () => {
  function withSources() {
    const fixture = setup();
    const store = TestBed.inject(SettingsStore);
    const other = { ...llamaSource('other-a'), provider: 'openai', models: [] } as LlmProviderConfig;
    store.llmProviders.set([other, llamaSource('local-a')]);
    fixture.detectChanges();
    const open = TestBed.inject(ThemedConfirmDialogService).open as ReturnType<typeof vi.fn>;
    const removeRow = (id: string) => {
      const row = (fixture.nativeElement as HTMLElement).querySelector(`[data-tutorial-source-id="${id}"]`);
      row!.querySelector<HTMLButtonElement>('.source-row__remove')!.click();
      return fixture.whenStable();
    };
    const ids = () => store.llmProviders().map((p) => p.id);
    return { store, open, removeRow, ids };
  }

  it('keeps a local model source when the dialog is cancelled', async () => {
    const { store, open, removeRow, ids } = withSources();
    await removeRow('local-a');
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]![0].message).toContain(store.sourceDisplayName(llamaSource('local-a')));
    expect(ids()).toEqual(['other-a', 'local-a']);
    expect(store.settingsDirty()).toBe(false);
  });

  it('removes a local model source once confirmed', async () => {
    const { open, removeRow, ids } = withSources();
    open.mockResolvedValueOnce('confirm');
    await removeRow('local-a');
    expect(ids()).toEqual(['other-a']);
  });

  it('removes other sources without asking', async () => {
    const { open, removeRow, ids } = withSources();
    await removeRow('other-a');
    expect(open).not.toHaveBeenCalled();
    expect(ids()).toEqual(['local-a']);
  });
});

describe('local source tutorial', () => {
  it('targets managed local defaults and advanced controls, not LM Studio or a URL-only server', () => {
    const fixture = setup();
    const store = TestBed.inject(SettingsStore);
    const host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    // LM Studio has its own settings panels instead of these sections.
    expect(host.querySelector('.ready-defaults')).toBeNull();
    expect(host.querySelector('.advanced-tuning summary')).toBeNull();
    expect(host.querySelector('app-lm-studio-controls')).not.toBeNull();
    expect(target(host, 'sources-defaults')).toBeNull();
    expect(target(host, 'sources-advanced')).toBeNull();
    expect(target(host, 'sources-local-model')).toBeNull();

    store.llmProviders.set([{ ...llamaSource(PINNED_LLAMA_SERVER_URL_PROVIDER_ID), provider: 'openai-compatible' }]);
    store.selectedModelId.set('llama-model');
    fixture.detectChanges();
    expect(host.querySelector('.ready-defaults')).toBeNull();
    expect(target(host, 'sources-defaults')).toBeNull();
    expect(target(host, 'sources-advanced')).toBeNull();
    expect(target(host, 'sources-local-model')).toBeNull();

    store.llmProviders.set([llamaSource('managed-source')]);
    fixture.detectChanges();
    expect(target(host, 'sources-defaults')?.textContent).toContain('Ready defaults');
    expect(target(host, 'sources-defaults')?.querySelector('app-pill-select')).not.toBeNull();
    expect(target(host, 'sources-advanced')?.tagName).toBe('SUMMARY');
    expect(target(host, 'sources-local-model')?.querySelector('.pill-select__trigger')).not.toBeNull();

    const before = structuredClone(store.llmProviders());
    const choose = vi.spyOn(store, 'onManagedInventoryPick');
    for (const stepId of ['sources-model', 'sources-defaults', 'sources-advanced', 'sources-apply']) {
      window.dispatchEvent(new CustomEvent('clara-tutorial-step', { detail: { phaseId: 'local-source', stepId } }));
    }
    fixture.detectChanges();
    expect(store.llmProviders()).toEqual(before);
    expect(store.settingsDirty()).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    expect(TestBed.inject(ElectronService).saveConfig).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('distinguishes loading, an empty inventory with the sample HF entry, and a failed scan', async () => {
    const fixture = setup();
    const store = TestBed.inject(SettingsStore);
    const electron = TestBed.inject(ElectronService);
    const host = fixture.nativeElement as HTMLElement;
    store.llmProviders.set([llamaSource('managed-source')]);
    store.selectedModelId.set('llama-model');
    fixture.detectChanges();
    expect(target(host, 'sources-local-model')?.getAttribute('data-tutorial-models-state')).toBe('unknown');
    expect(target(host, 'sources-model-manager')).toBeNull();

    store.modelManagerLocalLoading.set(true);
    fixture.detectChanges();
    expect(target(host, 'sources-local-model')?.getAttribute('data-tutorial-models-state')).toBe('loading');
    expect(target(host, 'sources-model-manager')).toBeNull();

    await store.refreshCustomModelCards(); // An unconfigured folder resolves to an empty inventory.
    store.modelManagerLocalLoading.set(false);
    fixture.detectChanges();
    expect(store.managedPickerValue()).toMatch(/^hf:/);
    expect(target(host, 'sources-local-model')?.getAttribute('data-tutorial-models-state')).toBe('empty');
    expect(target(host, 'sources-model-manager')?.textContent).toContain('Model Manager');
    expect(host.textContent).toContain('No downloaded local models are listed');

    const before = structuredClone(store.llmProviders());
    (target(host, 'sources-model-manager') as HTMLButtonElement).click();
    expect(store.selectedSettingsTab()).toBe('modelManager');
    expect(store.llmProviders()).toEqual(before);
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
    expect(electron.saveConfig).not.toHaveBeenCalled();

    store.modelManagerCustomModels.set([{
      fileName: 'example.gguf', absolutePath: '/models/example.gguf', sizeBytes: 1, modifiedMs: 0, source: 'custom',
    }]);
    fixture.detectChanges();
    expect(target(host, 'sources-local-model')?.getAttribute('data-tutorial-models-state')).toBe('ready');
    expect(target(host, 'sources-model-manager')).toBeNull();

    store.modelManagerCustomDir.set('/unavailable');
    vi.mocked(electron.modelManagerListCustomModels).mockResolvedValueOnce({ ok: false, error: 'permission denied' });
    const scanning = store.refreshCustomModelCards();
    fixture.detectChanges();
    expect(target(host, 'sources-local-model')?.getAttribute('data-tutorial-models-state')).toBe('loading');
    expect(target(host, 'sources-model-manager')).toBeNull();
    await scanning;
    fixture.detectChanges();
    expect(target(host, 'sources-local-model')?.getAttribute('data-tutorial-models-state')).toBe('error');
    expect(host.textContent).toContain('Local models could not be checked');
    expect(host.textContent).not.toContain('No downloaded local models are listed');
    expect(target(host, 'sources-model-manager')).not.toBeNull();
    expect(electron.modelManagerDownloadHfFile).not.toHaveBeenCalled();
    expect(electron.saveConfig).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('explains local requirements, metadata, inference and whole-draft Apply without promising side effects', () => {
    const step = (phaseId: string, stepId: string) => tutorialStepFor({ phaseId, stepId })!;
    expect(step('intro', 'welcome').body).toContain('Agentic Integrated Development Environment');
    expect(step('intro', 'home-navigation').targets).toEqual(['home-sources', 'home-settings-menu']);
    expect(step('local-engine', 'engine-intro').body).toContain('requires llama-server');
    expect(step('local-engine', 'engine-install').body).toContain('including a reinstall');
    expect(step('featured-models', 'featured-intro').body).toContain('metadata uses the network');
    expect(step('featured-models', 'featured-largest').body).toContain('highest total parameter count');
    expect(step('featured-models', 'featured-preview').body).toContain('No model is downloaded');
    expect(step('featured-models', 'featured-quantizations').body).toContain('GGUF is a model-file format');
    expect(step('local-source', 'sources-add').body).toContain('does not activate');
    expect(step('local-source', 'sources-model').body).toContain('not a downloaded model');
    expect(step('local-source', 'sources-defaults').body).toContain('inference templates');
    expect(step('local-source', 'sources-advanced').wiki).toBe(true);
    expect(step('local-source', 'sources-apply').body).toContain('all unsaved Settings changes');
  });
});

describe('LM Studio connection state', () => {
  const card = { id: 'hash-1', displayName: 'Gemma 4', type: 'llm', publisher: '', arch: '', compatibility_type: '', quantization: '', state: 'not-loaded', max_context_length: 4096, loaded_context_length: 0 };
  const api = () => {
    const electron = TestBed.inject(ElectronService) as unknown as Record<string, unknown>;
    const list = vi.fn(async () => ({ ok: true, origin: 'http://127.0.0.1:1234', source: 'v1', models: [card] }));
    Object.assign(electron, {
      lmStudioListModels: list,
      lmStudioLoadModel: vi.fn(async () => ({ ok: true })),
      lmStudioUnloadModel: vi.fn(async () => ({ ok: true })),
      applyLiveContextWindow: vi.fn(),
    });
    return { electron, list };
  };

  it('is connected after a listing and stale once the base URL changes', async () => {
    setup();
    const store = TestBed.inject(SettingsStore);
    api();
    expect(store.lmStudioStatus()).toBe('idle');
    await store.refreshLmStudioInventory();
    expect(store.lmStudioStatus()).toBe('connected');
    store.updateSelectedProvider({ baseUrl: 'http://127.0.0.1:9999/v1' });
    expect(store.lmStudioStatus()).toBe('stale');
  });

  it('is offline when the listing fails, and stays connected when only a load fails', async () => {
    setup();
    const store = TestBed.inject(SettingsStore);
    const { electron, list } = api();
    await store.refreshLmStudioInventory();
    electron['lmStudioLoadModel'] = vi.fn(async () => ({ ok: false, error: 'Out of memory' }));
    await store.loadLmStudioModel('hash-1');
    expect(store.lmStudioStatus()).toBe('connected');
    expect(store.lmStudioInventoryError()).toBe('hash-1: Out of memory');
    list.mockResolvedValueOnce({ ok: false, error: 'refused' } as never);
    await store.refreshLmStudioInventory();
    expect(store.lmStudioStatus()).toBe('offline');
  });

  it('marks a model busy for the length of a load and sends the saved settings', async () => {
    setup();
    const store = TestBed.inject(SettingsStore);
    const { electron } = api();
    let finish = (_: unknown) => {};
    const load = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    electron['lmStudioLoadModel'] = load;
    await store.refreshLmStudioInventory();
    store.updateLmStudioSettings({ contextLength: 2048, parallel: 2 });
    const pending = store.loadLmStudioModel('hash-1');
    expect(store.lmStudioModelBusy('hash-1')).toBe(true);
    await store.loadLmStudioModel('hash-1');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'hash-1', options: expect.objectContaining({ contextLength: 2048, parallel: 2, flashAttention: true }) }),
    );
    finish({ ok: true });
    await pending;
    expect(store.lmStudioModelBusy('hash-1')).toBe(false);
  });

  it('cuts a saved context down to what the model supports', async () => {
    setup();
    const store = TestBed.inject(SettingsStore);
    const { electron } = api();
    await store.refreshLmStudioInventory();
    await store.loadLmStudioModel('hash-1');
    expect(electron['lmStudioLoadModel']).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ contextLength: 4096 }) }));
  });

  it('asks for a reload only when the running model differs from the saved settings', async () => {
    setup();
    const store = TestBed.inject(SettingsStore);
    const { list } = api();
    const running = { contextLength: 4096, parallel: 4, evalBatchSize: 2048, flashAttention: true, offloadKvCacheToGpu: true };
    list.mockResolvedValue({ ok: true, origin: 'x', source: 'v1', models: [{ ...card, id: 'model', state: 'loaded', instanceId: 'i', runningConfig: running }] } as never);
    await store.refreshLmStudioInventory();
    expect(store.lmStudioNeedsReload()).toBe(false);
    store.updateLmStudioSettings({ parallel: 1 });
    expect(store.lmStudioNeedsReload()).toBe(true);
  });

  it('reloads with the new settings: unload first, then load', async () => {
    setup();
    const store = TestBed.inject(SettingsStore);
    const { electron, list } = api();
    const order: string[] = [];
    electron['lmStudioUnloadModel'] = vi.fn(async () => (order.push('unload'), { ok: true }));
    electron['lmStudioLoadModel'] = vi.fn(async () => (order.push('load'), { ok: true }));
    list.mockResolvedValue({ ok: true, origin: 'x', source: 'v1', models: [{ ...card, id: 'model', state: 'loaded', instanceId: 'i' }] } as never);
    await store.refreshLmStudioInventory();
    await store.reloadLmStudioChatModel();
    expect(order).toEqual(['unload', 'load']);
  });

  it('names a picked model after its display name, not its opaque id', async () => {
    setup();
    const store = TestBed.inject(SettingsStore);
    api();
    await store.refreshLmStudioInventory();
    store.onModelApiIdChange('hash-1');
    expect(store.selectedModel()).toMatchObject({ model: 'hash-1', name: 'Gemma 4' });
  });
});

describe('the OpenAI-compatible source store', () => {
  const compatSource = () =>
    ({
      id: PINNED_LLAMA_SERVER_URL_PROVIDER_ID,
      name: 'Custom',
      provider: 'openai-compatible',
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      models: [{ id: 'c1', name: 'm', model: 'm', contextWindowTokens: 8192, maxOutputTokens: 0 }],
    }) as unknown as LlmProviderConfig;
  const passed = { checks: [], testedModel: 'm', suggestions: {} };

  function ready() {
    const fixture = setup();
    const store = TestBed.inject(SettingsStore);
    const electron = TestBed.inject(ElectronService) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    electron['openAiCompatListModels'] = vi.fn(async () => ({ ok: true, models: [{ id: 'm', contextLength: 4096 }, { id: 'plain' }] }));
    electron['openAiCompatTest'] = vi.fn(async () => passed);
    store.llmProviders.set([compatSource()]);
    store.selectedModelId.set('c1');
    return { fixture, store, electron };
  }

  it('shows its own screen rather than the shared sections', () => {
    const { fixture } = ready();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('app-openai-compat-dashboard')).not.toBeNull();
    expect(host.querySelector('.ready-defaults')).toBeNull();
    expect(host.querySelector('.advanced-tuning')).toBeNull();
  });

  it('lists models with the connection as typed, including headers', async () => {
    const { store, electron } = ready();
    store.updateSelectedProvider({ baseUrl: 'http://typed/v1', customHeaders: [{ key: 'h', value: 'v' as never }] });
    await store.refreshOpenAiCompatModels();
    expect(electron['openAiCompatListModels']).toHaveBeenCalledWith({ baseUrl: 'http://typed/v1', apiKey: 'k', headers: [{ key: 'h', value: 'v' }] });
    expect(store.openAiCompatModels().map((m) => m.id)).toEqual(['m', 'plain']);
  });

  it('ignores a slow listing once a newer one has started', async () => {
    const { store, electron } = ready();
    let finishOld = (_: unknown) => {};
    electron['openAiCompatListModels'] = vi.fn(() => new Promise((resolve) => (finishOld = resolve)));
    const old = store.refreshOpenAiCompatModels();
    electron['openAiCompatListModels'] = vi.fn(async () => ({ ok: true, models: [{ id: 'new' }] }));
    await store.refreshOpenAiCompatModels();
    finishOld({ ok: true, models: [{ id: 'old' }] });
    await old;
    expect(store.openAiCompatModels().map((m) => m.id)).toEqual(['new']);
    expect(store.openAiCompatListInFlight()).toBe(false);
  });

  it('takes a context size the server reports, and otherwise keeps what was typed', async () => {
    const { store } = ready();
    await store.refreshOpenAiCompatModels();
    store.onModelApiIdChange('m');
    expect(store.selectedModel()?.contextWindowTokens).toBe(4096);
    store.onContextWindowTokensChange(50000);
    store.onModelApiIdChange('plain');
    expect(store.selectedModel()?.contextWindowTokens).toBe(50000);
    store.onModelApiIdChange('typed-id');
    expect(store.selectedModel()?.contextWindowTokens).toBe(50000);
  });

  it('applies what the test learned, and says so', async () => {
    const { store, electron } = ready();
    electron['openAiCompatTest'] = vi.fn(async () => ({ ...passed, suggestions: { streamUsage: false, tokensField: 'max_tokens' } }));
    await store.runOpenAiCompatConnectionTest();
    expect(store.openAiCompatSettings().streamUsage).toBe(false);
    expect(store.openAiCompatApplied()).toEqual(['token usage not requested']);
  });

  it('is stale once anything the test depended on changes', async () => {
    const { store } = ready();
    await store.runOpenAiCompatConnectionTest();
    expect(store.openAiCompatTestStale()).toBe(false);
    store.updateSelectedProvider({ baseUrl: 'http://other/v1' });
    expect(store.openAiCompatTestStale()).toBe(true);
  });

  it('forgets a test when moving to another source, ignoring one still running', async () => {
    const { store, electron } = ready();
    let finish = (_: unknown) => {};
    electron['openAiCompatTest'] = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const running = store.runOpenAiCompatConnectionTest();
    expect(store.openAiCompatTestRunning()).toBe(true);
    store.selectSource(PINNED_LLAMA_SERVER_URL_PROVIDER_ID);
    finish(passed);
    await running;
    expect(store.openAiCompatTestResult()).toBeNull();
    expect(store.openAiCompatTestRunning()).toBe(false);
  });

  it('labels the source', () => {
    const { store } = ready();
    expect(store.providerKindLabel(store.selectedProvider()!)).toBe('OpenAI-compatible');
  });
});
