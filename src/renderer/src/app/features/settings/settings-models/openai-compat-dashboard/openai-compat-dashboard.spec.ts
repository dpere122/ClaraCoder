import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeOpenAiCompatSettings,
  unwrapSecret,
  type OpenAiCompatSettings,
  type OpenAiCompatTestResult,
  type SecretStorageMode,
} from '@shared/index';
import { lucideAppProviders } from '../../../../lucide-setup';
import { SettingsStore } from '../../settings/settings-store';
import { OpenAiCompatDashboardComponent } from './openai-compat-dashboard';

function setup(
  options: {
    baseUrl?: string;
    apiKey?: string;
    headers?: { key: string; value: string }[];
    compat?: Partial<OpenAiCompatSettings>;
    result?: OpenAiCompatTestResult | null;
    stale?: boolean;
    running?: boolean;
    storage?: SecretStorageMode;
  } = {},
) {
  const compat = signal(normalizeOpenAiCompatSettings(options.compat));
  const store = {
    selectedProvider: signal({
      id: 'url',
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:8080',
      apiKey: options.apiKey ?? '',
      customHeaders: options.headers ?? [],
    }),
    selectedModel: signal({ id: 'm1', model: 'gpt' }),
    selectedResolved: signal({ optimizationPreset: 'generic', thinkingMode: 'default', reasoningEffort: '', temperature: 0.5, contextWindowTokens: 8192, maxOutputTokens: 0, parallelToolCalls: true }),
    openAiCompatSettings: compat,
    openAiCompatModels: signal([{ id: 'gpt', contextLength: 8192 }, { id: 'other' }]),
    openAiCompatListError: signal<string | null>(null),
    openAiCompatListInFlight: signal(false),
    openAiCompatTestRunning: signal(!!options.running),
    openAiCompatTestResult: signal(options.result ?? null),
    openAiCompatTestStale: signal(!!options.stale),
    openAiCompatApplied: signal<string[]>([]),
    modelManagerSecretStorage: signal<SecretStorageMode | null>(options.storage ?? 'keychain'),
    refreshSecretStorage: vi.fn(async () => undefined),
    refreshOpenAiCompatModels: vi.fn(async () => undefined),
    runOpenAiCompatConnectionTest: vi.fn(async () => undefined),
    updateOpenAiCompatSettings: vi.fn((c: Partial<OpenAiCompatSettings>) => compat.update((s) => ({ ...s, ...c }))),
    updateSelectedProvider: vi.fn(),
    updateSelectedModel: vi.fn(),
    onModelApiIdChange: vi.fn(),
    onContextWindowTokensChange: vi.fn(),
    onMaxOutputTokensChange: vi.fn(),
    onTemperatureChange: vi.fn(),
    onOptimizationPresetChange: vi.fn(),
    sourceIsActive: vi.fn(() => false),
    activateSource: vi.fn(),
    readyDefaultsSummary: signal('Summary'),
    presetsFor: () => [{ id: 'generic', label: 'Generic', summary: '' }],
  };
  TestBed.configureTestingModule({
    imports: [OpenAiCompatDashboardComponent],
    providers: [...lucideAppProviders, { provide: SettingsStore, useValue: store }],
  });
  const fixture = TestBed.createComponent(OpenAiCompatDashboardComponent);
  fixture.detectChanges();
  return { fixture, store, host: fixture.nativeElement as HTMLElement };
}

const field = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLElement>('.field, .lms-toggle')].find((f) => f.textContent?.includes(label));
const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().includes(name));
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

const passing: OpenAiCompatTestResult = {
  testedModel: 'gpt',
  suggestions: {},
  checks: [
    { id: 'reachable', label: 'Server and API key', status: 'ok', detail: 'Answered.' },
    { id: 'tools', label: 'Tool calling', status: 'ok', detail: 'Called it.' },
  ],
};

beforeEach(() => TestBed.resetTestingModule());

describe('the OpenAI-compatible source', () => {
  it('lays out Connection, Model, Compatibility and Request settings, with no rename field', () => {
    const { host } = setup();
    expect([...host.querySelectorAll('.lms-panel h5')].map((h) => h.textContent)).toEqual(['Connection', 'Model', 'Compatibility', 'Request settings']);
    expect(field(host, 'Name')).toBeUndefined();
    expect(host.querySelector('.lms-connection__status .lms-status')?.textContent).toContain('Not tested');
  });

  describe('connection', () => {
    it('shows where requests will go, adding /v1 only when the URL has no path', () => {
      expect(setup().host.querySelector('.oc-resolved')?.textContent).toContain('http://127.0.0.1:8080/v1/chat/completions');
      TestBed.resetTestingModule();
      expect(setup({ baseUrl: 'https://x.dev/openai/v2/' }).host.querySelector('.oc-resolved')?.textContent).toContain('https://x.dev/openai/v2/chat/completions');
    });

    it('cannot test or list without a valid URL', () => {
      const { host } = setup({ baseUrl: 'ftp://x' });
      expect(host.querySelector('.oc-resolved')?.textContent).toContain('valid http or https');
      expect(buttonNamed(host, 'Test connection')!.disabled).toBe(true);
      expect(buttonNamed(host, 'Refresh list')!.disabled).toBe(true);
    });

    it('says how secrets are stored, only once there is one', () => {
      expect(setup().host.textContent).not.toContain('Encrypted');
      TestBed.resetTestingModule();
      expect(setup({ apiKey: 'k' }).host.textContent).toContain('Encrypted');
      TestBed.resetTestingModule();
      expect(setup({ headers: [{ key: 'api-key', value: 'v' }] }).host.textContent).toContain('Encrypted');
      TestBed.resetTestingModule();
      expect(setup({ apiKey: 'k', storage: 'plaintext' }).host.textContent).toContain('Not encrypted');
    });

    it('adds, edits and removes custom headers', () => {
      const { host, store } = setup({ headers: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] });
      const saved = () => {
        const headers = (store.updateSelectedProvider.mock.calls.at(-1) as unknown as [{ customHeaders: { key: string; value: unknown }[] }])[0].customHeaders;
        return headers.map((h) => [h.key, unwrapSecret(h.value)]);
      };
      buttonNamed(host, 'Add header')!.click();
      expect(saved()).toEqual([['a', '1'], ['b', '2'], ['', '']]);
      type(host.querySelectorAll<HTMLInputElement>('.oc-header-row input[type="password"]')[1]!, 'secret');
      expect(saved()).toEqual([['a', '1'], ['b', 'secret']]);
      host.querySelector<HTMLButtonElement>('.oc-header-row button')!.click();
      expect(saved()).toEqual([['b', '2']]);
    });

    it('masks header values', () => {
      const { host } = setup({ headers: [{ key: 'a', value: '1' }] });
      expect(host.querySelector<HTMLInputElement>('.oc-header-row input[aria-label="Header value"]')?.type).toBe('password');
    });
  });

  describe('the connection test', () => {
    it('runs when asked, never by itself, and warns that it can cost', () => {
      const { host, store } = setup();
      expect(store.runOpenAiCompatConnectionTest).not.toHaveBeenCalled();
      expect(host.querySelector('.lms-connection__status')?.textContent).toContain('can cost a little');
      buttonNamed(host, 'Test connection')!.click();
      expect(store.runOpenAiCompatConnectionTest).toHaveBeenCalled();
    });

    it('lists each check with its result', () => {
      const { host } = setup({ result: passing });
      const rows = [...host.querySelectorAll('.oc-check')];
      expect(rows.length).toBe(2);
      expect(rows[0]?.textContent).toContain('Server and API key');
      expect(rows[0]?.classList).toContain('oc-check--ok');
    });

    it('sums the checks up in the status', () => {
      const withStatus = (status: 'ok' | 'warn' | 'fail') => ({ ...passing, checks: [{ ...passing.checks[0]!, status }] });
      const label = (over: Parameters<typeof setup>[0]) => {
        TestBed.resetTestingModule();
        return setup(over).host.querySelector('.lms-status')?.textContent;
      };
      expect(label({ result: withStatus('ok') })).toContain('All checks passed');
      expect(label({ result: withStatus('warn') })).toContain('Works, with warnings');
      expect(label({ result: withStatus('fail') })).toContain('Problems found');
      expect(label({ result: withStatus('ok'), stale: true })).toContain('Changed since the last test');
      expect(label({ running: true })).toContain('Testing');
    });

    it('says what it changed, so an update is never silent', () => {
      const { host, store, fixture } = setup({ result: passing });
      store.openAiCompatApplied.set(['token usage not requested']);
      fixture.detectChanges();
      expect(host.textContent).toContain('Compatibility updated to match: token usage not requested');
    });
  });

  describe('model', () => {
    it('offers the listed models and accepts a typed ID', () => {
      const { host, store } = setup();
      expect([...host.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['gpt', 'other']);
      type(host.querySelector<HTMLInputElement>('input[list="openai-compat-models"]')!, 'not-listed');
      expect(store.onModelApiIdChange).toHaveBeenCalledWith('not-listed');
    });

    it('says whether the context window came from the server', () => {
      const { host, store, fixture } = setup();
      expect(field(host, 'Context window')?.textContent).toContain('Reported by the server');
      store.selectedModel.set({ id: 'm1', model: 'other' });
      fixture.detectChanges();
      expect(field(host, 'Context window')?.textContent).toContain('type it in');
    });

    it('shows a listing error', () => {
      const { host, store, fixture } = setup();
      store.openAiCompatListError.set('HTTP 404');
      fixture.detectChanges();
      expect(host.textContent).toContain("Couldn't list models: HTTP 404");
    });
  });

  describe('request settings', () => {
    it('hides thinking until the server has a way to control it', () => {
      expect(field(setup().host, 'Thinking')?.textContent).toContain('Thinking control');
      TestBed.resetTestingModule();
      const { host } = setup({ compat: { thinkingMethod: 'reasoning_effort' } });
      const labels = [...host.querySelectorAll('.field > span')].map((s) => s.textContent?.trim());
      expect(labels).toContain('Thinking');
    });

    it('saves thinking in the fields the backend reads', () => {
      const { fixture, store } = setup({ compat: { thinkingMethod: 'reasoning_effort' } });
      const c = fixture.componentInstance as unknown as { onThinkingChange(v: string): void };
      c.onThinkingChange('off');
      expect(store.updateSelectedModel).toHaveBeenLastCalledWith({ thinkingMode: 'off', reasoningEffort: '' });
      c.onThinkingChange('high');
      expect(store.updateSelectedModel).toHaveBeenLastCalledWith({ thinkingMode: 'default', reasoningEffort: 'high' });
    });

    it('turns off the temperature slider when it is not sent', async () => {
      const { host, fixture } = setup({ compat: { sendTemperature: false } });
      await fixture.whenStable();
      expect(host.querySelector<HTMLInputElement>('input[type="range"]')?.disabled).toBe(true);
      expect(field(host, 'Temperature')?.textContent).toContain('Not sent');
    });

    it('shows non-standard sampling only when turned on', () => {
      expect(field(setup().host, 'Top K')).toBeUndefined();
      TestBed.resetTestingModule();
      expect(field(setup({ compat: { nonStandardSampling: true } }).host, 'Top K')).toBeDefined();
    });

    it('keeps up to four stop sequences, one per line', () => {
      const { host, store } = setup();
      type(field(host, 'Stop sequences')!.querySelector('textarea')!, 'a\n\nb\nc\nd\ne');
      expect(store.updateOpenAiCompatSettings).toHaveBeenLastCalledWith({ stop: ['a', 'b', 'c', 'd'] });
    });

    it('clears a number setting back to not set', () => {
      const { fixture, store } = setup();
      const c = fixture.componentInstance as unknown as { onNumberSetting(k: string, v: unknown): void };
      c.onNumberSetting('seed', 7);
      expect(store.updateOpenAiCompatSettings).toHaveBeenLastCalledWith({ seed: 7 });
      c.onNumberSetting('seed', null);
      expect(store.updateOpenAiCompatSettings).toHaveBeenLastCalledWith({ seed: null });
    });

    it('checks the extra request body as you type', () => {
      const { host, fixture } = setup({ compat: { extraBody: '{"a": 1}' } });
      expect(host.querySelector('.oc-json-error')).toBeNull();
      type(field(host, 'Extra request body')!.querySelector('textarea')!, '{not json');
      fixture.detectChanges();
      expect(host.querySelector('.oc-json-error')?.textContent).toContain("won't be sent");
      expect(host.querySelector('.oc-json')?.classList).toContain('oc-json--invalid');
      type(field(host, 'Extra request body')!.querySelector('textarea')!, '[1]');
      fixture.detectChanges();
      expect(host.querySelector('.oc-json-error')?.textContent).toContain('JSON object');
    });
  });
});
