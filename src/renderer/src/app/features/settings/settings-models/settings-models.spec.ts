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

function setup() {
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
      { provide: ThemedConfirmDialogService, useValue: {} },
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
      provider: 'lmstudio',
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
    const fixture = setup();
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
    expect(gemma?.providers).toEqual(['lmstudio', 'llamacpp']);
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

describe('local source tutorial', () => {
  it('targets managed local defaults and advanced controls, not LM Studio or a URL-only server', () => {
    const fixture = setup();
    const store = TestBed.inject(SettingsStore);
    const host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    expect(host.querySelector('.ready-defaults')).not.toBeNull();
    expect(host.querySelector('.advanced-tuning summary')).not.toBeNull();
    expect(target(host, 'sources-defaults')).toBeNull();
    expect(target(host, 'sources-advanced')).toBeNull();
    expect(target(host, 'sources-local-model')).toBeNull();

    store.llmProviders.set([llamaSource(PINNED_LLAMA_SERVER_URL_PROVIDER_ID)]);
    store.selectedModelId.set('llama-model');
    fixture.detectChanges();
    expect(host.querySelector('.ready-defaults')).not.toBeNull();
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
