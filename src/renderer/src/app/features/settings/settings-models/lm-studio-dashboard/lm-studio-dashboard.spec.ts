import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LM_STUDIO_PLACEHOLDER_API_KEY, normalizeLmStudioSettings, unwrapSecret, type LmStudioModelCard, type SecretStorageMode } from '@shared/index';
import { lucideAppProviders } from '../../../../lucide-setup';
import type { LmStudioConnection, LmStudioStatus } from '../../settings/settings-store';
import { SettingsStore } from '../../settings/settings-store';
import { LmStudioDashboardComponent } from './lm-studio-dashboard';

const chat: LmStudioModelCard = {
  id: 'hash-1',
  displayName: 'Gemma 4',
  type: 'llm',
  publisher: 'google',
  arch: 'gemma4',
  compatibility_type: 'gguf',
  quantization: 'Q4_K_M',
  state: 'not-loaded',
  max_context_length: 262144,
  loaded_context_length: 0,
  sizeBytes: 1024,
  toolUse: true,
};
const embed: LmStudioModelCard = { ...chat, id: 'embed-1', displayName: 'Nomic', type: 'embedding' };

function setup(
  options: {
    status?: LmStudioStatus;
    source?: 'v0' | 'v1';
    models?: LmStudioModelCard[];
    model?: string;
    apiKey?: string;
    storage?: SecretStorageMode;
  } = {},
) {
  const provider = signal({ id: 'lm', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: (options.apiKey ?? LM_STUDIO_PLACEHOLDER_API_KEY) as unknown });
  const inventory = signal(options.models ?? [chat, embed]);
  const status = signal<LmStudioStatus>(options.status ?? 'connected');
  const connection = signal<LmStudioConnection | null>(
    status() === 'connected' ? { baseUrl: provider().baseUrl, origin: 'http://127.0.0.1:1234', source: options.source ?? 'v1' } : null,
  );
  const modelId = options.model ?? chat.id;
  const store = {
    selectedProvider: provider,
    selectedModel: signal({ id: 'm1', model: modelId }),
    lmStudioInventory: inventory,
    lmStudioInventoryError: signal<string | null>(null),
    lmStudioListInFlight: signal(false),
    lmStudioStatus: status,
    lmStudioConnection: connection,
    lmStudioChatCard: signal(inventory().find((c) => c.id === modelId) ?? null),
    lmStudioModelBusy: vi.fn(() => false),
    loadLmStudioModel: vi.fn(async () => undefined),
    unloadLmStudioCard: vi.fn(async () => undefined),
    refreshLmStudioInventory: vi.fn(async () => undefined),
    refreshSecretStorage: vi.fn(async () => undefined),
    lmStudioSettings: signal(normalizeLmStudioSettings(undefined)),
    lmStudioNeedsReload: signal(false),
    selectedResolved: signal(null),
    presetsFor: () => [],
    modelManagerSecretStorage: signal<SecretStorageMode | null>(options.storage ?? 'keychain'),
    onModelApiIdChange: vi.fn(),
    updateSelectedProvider: vi.fn(),
    sourceIsActive: vi.fn(() => false),
    activateSource: vi.fn(),
    formatModelBytes: vi.fn(() => '1 KB'),
  };
  TestBed.configureTestingModule({
    imports: [LmStudioDashboardComponent],
    providers: [...lucideAppProviders, { provide: SettingsStore, useValue: store }],
  });
  const fixture = TestBed.createComponent(LmStudioDashboardComponent);
  fixture.detectChanges();
  return { fixture, store, host: fixture.nativeElement as HTMLElement };
}

const button = (host: HTMLElement, root: string, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(`${root} button`)].find((b) => b.textContent?.trim() === label);
const triggers = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.pill-select__trigger')];
const openMenu = (fixture: { detectChanges(): void }, trigger: HTMLButtonElement) => {
  trigger.click();
  fixture.detectChanges();
  return [...document.querySelectorAll('.pill-select__option')].map((o) => o.textContent?.trim());
};

beforeEach(() => TestBed.resetTestingModule());

describe('the LM Studio dashboard', () => {
  it('puts the connection first with its status beside the fields, then the chat model', () => {
    const { host } = setup();
    const sections = [...host.querySelectorAll('.lms-panel h5')].map((h) => h.textContent);
    expect(sections.slice(0, 2)).toEqual(['Connection', 'Chat model']);
    const box = host.querySelector('.lms-connection')!;
    expect(box.querySelector('.lms-connection__status .lms-status')?.textContent).toContain('Connected');
    expect(box.querySelector('.lms-connection__fields')?.textContent).toContain('Base URL');
  });

  it('offers no way to rename the source', () => {
    const { host } = setup();
    expect(host.querySelector('.lms-connection')?.textContent).not.toContain('Name');
    expect(host.querySelectorAll('.lms-connection input').length).toBe(2);
  });

  it('shows the server stats under Load settings, in the same column', () => {
    const { host } = setup();
    const side = host.querySelector('.lms-controls__side')!;
    expect(side.querySelector('.lms-panel h5')?.textContent).toBe('Load settings');
    expect(side.lastElementChild?.matches('.lms-tiles')).toBe(true);
    expect(host.querySelectorAll('.lms-tile').length).toBe(4);
  });

  it('has no model library', () => {
    const { host } = setup();
    expect(host.textContent).not.toContain('Model library');
    expect(host.querySelector('.lms-card')).toBeNull();
  });

  it('lists only the chat models the server has', () => {
    const { host, fixture } = setup({ model: 'local-model' });
    const options = openMenu(fixture, triggers(host)[0]!);
    expect(options).toEqual(['Gemma 4 · Q4_K_M']);
  });

  it('shows a prompt instead of a saved model the server does not have', () => {
    const { host } = setup({ model: 'local-model' });
    expect(triggers(host)[0]!.textContent).toContain('Select a model');
    expect(host.querySelector('.lms-note--warn')?.textContent).toContain("local-model, isn't on this server");
    expect(host.querySelector('.lms-control-row .action-button')).toBeNull();
  });

  it('turns the dropdown off until a server has listed its models', () => {
    const { host } = setup({ status: 'offline', models: [], model: 'local-model' });
    expect(triggers(host)[0]!.disabled).toBe(true);
    expect(triggers(host)[0]!.textContent).toContain('Connect to list models');
  });

  it('explains how to start the server when it cannot be reached', () => {
    const { host, fixture, store } = setup({ status: 'offline', models: [] });
    store.lmStudioInventoryError.set('fetch failed');
    fixture.detectChanges();
    expect(host.querySelector('.lms-connection .lms-alert')?.textContent).toContain('lms server start');
  });

  it('loads and unloads the chat model', () => {
    const { store, host } = setup();
    button(host, '.lms-control-row', 'Load')!.click();
    expect(store.loadLmStudioModel).toHaveBeenCalledWith('hash-1');
    TestBed.resetTestingModule();
    const loaded = { ...chat, state: 'loaded', instanceId: 'inst', loaded_context_length: 4096 };
    const second = setup({ models: [loaded] });
    button(second.host, '.lms-control-row', 'Unload')!.click();
    expect(second.store.unloadLmStudioCard).toHaveBeenCalledWith(loaded);
  });

  it('warns when the model was not trained for tool use, since the agent depends on it', () => {
    expect(setup().host.querySelector('.lms-caps')?.textContent).toContain('Tool use');
    TestBed.resetTestingModule();
    const { host } = setup({ models: [{ ...chat, toolUse: false, vision: true }] });
    expect(host.querySelector('.lms-caps')?.textContent).toContain('Not trained for tools');
    expect(host.querySelector('.lms-caps')?.textContent).toContain('Vision');
    expect(host.querySelector('.lms-note--warn')?.textContent).toContain('may struggle with coding tasks');
  });

  it('turns off load controls on a server without the v1 API', () => {
    const { host } = setup({ source: 'v0' });
    expect(button(host, '.lms-control-row', 'Load')!.disabled).toBe(true);
    expect(host.textContent).toContain('need LM Studio 0.4 or newer');
  });

  it('hides the placeholder key and restores it when the token is cleared', () => {
    const { host, store } = setup();
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.value).toBe('');
    input.value = 'real-token';
    input.dispatchEvent(new Event('input'));
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const saved = store.updateSelectedProvider.mock.calls.map((c) => unwrapSecret((c as unknown as [{ apiKey: unknown }])[0].apiKey));
    expect(saved).toEqual(['real-token', LM_STUDIO_PLACEHOLDER_API_KEY]);
  });

  it('says how a real token is stored, and says nothing about the placeholder', () => {
    expect(setup().host.textContent).not.toContain('Encrypted');
    TestBed.resetTestingModule();
    expect(setup({ apiKey: 'real-token' }).host.querySelector('.lms-token-label')?.textContent).toContain('Encrypted');
    TestBed.resetTestingModule();
    expect(setup({ apiKey: 'real-token', storage: 'plaintext' }).host.querySelector('.lms-token-label')?.textContent).toContain('Not encrypted');
  });
});
