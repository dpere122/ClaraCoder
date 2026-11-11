import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeLmStudioSettings, type LmStudioModelCard, type LmStudioSettings } from '@shared/index';
import { lucideAppProviders } from '../../../../lucide-setup';
import { SettingsStore } from '../../settings/settings-store';
import { LmStudioControlsComponent } from './lm-studio-controls';

const gemma: LmStudioModelCard = {
  id: 'hash',
  displayName: 'Gemma 4',
  type: 'llm',
  publisher: '',
  arch: 'gemma4',
  compatibility_type: 'gguf',
  quantization: 'Q4_K_M',
  state: 'not-loaded',
  max_context_length: 16384,
  loaded_context_length: 0,
  reasoningOptions: ['off', 'on'],
  reasoningDefault: 'on',
};

function setup(options: { card?: LmStudioModelCard | null; settings?: Partial<LmStudioSettings>; needsReload?: boolean; preset?: string } = {}) {
  const settings = signal(normalizeLmStudioSettings(options.settings));
  const resolved = signal({ optimizationPreset: options.preset ?? 'generic', thinkingMode: 'default', reasoningEffort: '', temperature: 0.5, maxOutputTokens: 0, parallelToolCalls: true });
  const store = {
    selectedResolved: resolved,
    lmStudioChatCard: signal(options.card === undefined ? gemma : options.card),
    lmStudioSettings: settings,
    lmStudioNeedsReload: signal(!!options.needsReload),
    lmStudioModelBusy: vi.fn(() => false),
    reloadLmStudioChatModel: vi.fn(async () => undefined),
    updateLmStudioSettings: vi.fn((c: Partial<LmStudioSettings>) => settings.update((s) => ({ ...s, ...c }))),
    updateSelectedModel: vi.fn(),
    onOptimizationPresetChange: vi.fn(),
    onTemperatureChange: vi.fn(),
    onMaxOutputTokensChange: vi.fn(),
    readyDefaultsSummary: computed(() => 'Summary'),
    presetsFor: () => [
      { id: 'generic', label: 'Generic', summary: '' },
      { id: 'gemma', label: 'Gemma (local)', summary: '' },
    ],
  };
  TestBed.configureTestingModule({
    imports: [LmStudioControlsComponent],
    providers: [...lucideAppProviders, { provide: SettingsStore, useValue: store }],
  });
  const fixture = TestBed.createComponent(LmStudioControlsComponent);
  fixture.detectChanges();
  return { fixture, store, host: fixture.nativeElement as HTMLElement };
}

const field = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLElement>('.field, .lms-toggle')].find((f) => f.textContent?.includes(label));

beforeEach(() => TestBed.resetTestingModule());

describe('the LM Studio controls', () => {
  it('separates what applies at load from what applies per message', () => {
    const { host } = setup();
    const [load, response] = [...host.querySelectorAll('.lms-panel')];
    expect(load?.querySelector('h5')?.textContent).toBe('Load settings');
    expect(load?.textContent).toContain('Context length');
    expect(response?.querySelector('h5')?.textContent).toBe('Response settings');
    expect(response?.textContent).toContain('Temperature');
  });

  it('shows the context a load would really use', () => {
    const { host } = setup();
    expect(field(host, 'Context length')?.textContent).toContain('16K (model max)');
  });

  it('saves a changed load setting as a number', () => {
    const { fixture, store } = setup();
    (fixture.componentInstance as unknown as { onIntSetting(k: string, v: string): void }).onIntSetting('parallel', '2');
    expect(store.updateLmStudioSettings).toHaveBeenCalledWith({ parallel: 2 });
  });

  it('shows what a loaded model is running with, and no reload when that matches', () => {
    const running = { contextLength: 8192, parallel: 2, evalBatchSize: 512, flashAttention: true, offloadKvCacheToGpu: false };
    const { host } = setup({ card: { ...gemma, state: 'loaded', runningConfig: running } });
    const box = host.querySelector('.lms-running')!;
    expect(box.textContent).toContain('Running with these settings');
    expect(box.textContent).toContain('8K context');
    expect(box.textContent).toContain('2 parallel');
    expect(box.textContent).toContain('KV cache in RAM');
    expect(box.querySelector('button')).toBeNull();
  });

  it('offers a reload when settings changed under a running model', () => {
    const running = { contextLength: 8192 };
    const { host, store } = setup({ card: { ...gemma, state: 'loaded', runningConfig: running }, needsReload: true });
    expect(host.querySelector('.lms-running')?.textContent).toContain('Running with different settings');
    host.querySelector<HTMLButtonElement>('.lms-running button')!.click();
    expect(store.reloadLmStudioChatModel).toHaveBeenCalled();
  });

  it('has no running box for a model that is not loaded', () => {
    expect(setup().host.querySelector('.lms-running')).toBeNull();
  });

  it('offers idle unload only when LM Studio does the loading, since only then does it apply', () => {
    expect(field(setup().host, 'Unload after idle')).toBeUndefined();
    TestBed.resetTestingModule();
    const { host } = setup({ settings: { autoLoad: false } });
    expect(field(host, 'Unload after idle')?.textContent).toContain('1 hour');
    expect(field(host, 'Load with these settings')?.textContent).toContain('with its own settings');
  });

  it('offers thinking only with the options this model reports', () => {
    expect(field(setup().host, 'Thinking')?.textContent).toContain('On');
    TestBed.resetTestingModule();
    expect(field(setup({ card: { ...gemma, reasoningOptions: undefined } }).host, 'Thinking')).toBeUndefined();
    TestBed.resetTestingModule();
    expect(field(setup({ card: { ...gemma, reasoningOptions: ['on'] } }).host, 'Thinking')).toBeUndefined();
  });

  it('saves a thinking choice to the model profile', () => {
    const { fixture, store } = setup();
    (fixture.componentInstance as unknown as { onThinkingChange(v: string): void }).onThinkingChange('off');
    expect(store.updateSelectedModel).toHaveBeenCalledWith({ thinkingMode: 'off', reasoningEffort: '' });
  });

  it('suggests the profile that matches the model, and stops once it is chosen', () => {
    const { host, store } = setup();
    expect(host.querySelector('.lms-suggest')?.textContent).toContain('Gemma (local)');
    host.querySelector<HTMLButtonElement>('.lms-suggest button')!.click();
    expect(store.onOptimizationPresetChange).toHaveBeenCalledWith('gemma');
    TestBed.resetTestingModule();
    expect(setup({ preset: 'gemma' }).host.querySelector('.lms-suggest')).toBeNull();
  });

  it('has no context field for Clara to contradict the server with', () => {
    const { host } = setup();
    expect(host.querySelector('input[max="10000000"]')).toBeNull();
  });
});
