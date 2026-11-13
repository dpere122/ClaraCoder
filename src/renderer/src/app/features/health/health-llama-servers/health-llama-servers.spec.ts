import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  LlamaServerConsoleSnapshot,
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
} from '@shared/index';

/** A stand-in terminal that records what it was told and lets a test place its viewport. */
const mockTerminal = vi.hoisted(() => {
  const terminal = {
    written: [] as string[],
    buffer: { active: { viewportY: 0, baseY: 0 } },
    loadAddon: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    open: vi.fn(),
    onScroll: vi.fn(),
    dispose: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    reset: vi.fn(() => {
      terminal.written.length = 0;
    }),
    write: vi.fn((data: string, done?: () => void) => {
      terminal.written.push(data);
      done?.();
    }),
    scrollToTop: vi.fn(() => {
      terminal.buffer.active.viewportY = 0;
    }),
    scrollToBottom: vi.fn(() => {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY;
    }),
    scrollPages: vi.fn((pages: number) => {
      const active = terminal.buffer.active;
      active.viewportY = Math.min(active.baseY, Math.max(0, active.viewportY + pages * 10));
    }),
  };
  return terminal;
});

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function MockTerminal() {
    return mockTerminal;
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function MockFitAddon() {
    return { fit: vi.fn() };
  }),
}));

import { ElectronService } from '../../../core/electron.service';
import { HealthLlamaServers } from './health-llama-servers';

function local(id: string, name: string, runCommand = 'llama-server -m model.gguf') {
  return {
    id,
    name,
    customName: name,
    provider: 'llamacpp',
    baseUrl: '',
    apiKey: '',
    models: [{ id: `conn-${id}`, name, model: id, optimizationPreset: 'generic', llamaCppManaged: { chatRunCommand: runCommand } }],
  };
}

const CONFIG = {
  activeLlmModelId: 'conn-cloud',
  llmProviders: [
    { id: 'cloud', name: 'Cloud', provider: 'openai', baseUrl: '', apiKey: '', models: [{ id: 'conn-cloud', name: 'Cloud', model: 'gpt', optimizationPreset: 'generic' }] },
    local('qwen', 'Qwen'),
    local('gemma', 'Gemma'),
    local('blank', 'No command', '  '),
  ],
  modelManager: { customModelsDir: '' },
} as unknown as AppConfig;

async function setup(snapshots: LlamaServerConsoleSnapshot[] = [], config: AppConfig = CONFIG) {
  mockTerminal.buffer.active.viewportY = 0;
  mockTerminal.buffer.active.baseY = 0;
  mockTerminal.written.length = 0;
  vi.clearAllMocks();
  const output = new Subject<LlamaServerOutputEvent>();
  const lifecycle = new Subject<LlamaServerLifecycleEvent>();
  const electron = {
    config$: new Subject<AppConfig>(),
    loadConfig: vi.fn().mockResolvedValue(config),
    llamaServerOutput$: output.asObservable(),
    llamaServerLifecycle$: lifecycle.asObservable(),
    llamaServerConsoles: vi.fn().mockResolvedValue(snapshots),
    modelManagerListCustomModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
  };
  TestBed.configureTestingModule({
    imports: [HealthLlamaServers],
    providers: [{ provide: ElectronService, useValue: electron }],
  });
  const fixture = TestBed.createComponent(HealthLlamaServers);
  const host = fixture.nativeElement as HTMLElement;
  const refresh = async () => {
    for (let pass = 0; pass < 2; pass += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  };
  await refresh();
  const rows = () =>
    [...host.querySelectorAll<HTMLButtonElement>('.llama-servers__row')].map((row) => [
      row.querySelector('.llama-servers__name')?.textContent?.trim(),
      row.querySelector('[role="img"]')?.getAttribute('aria-label'),
      row.querySelector('.llama-servers__spinner') ? 'spinner' : 'light',
      row.getAttribute('aria-current') === 'true' ? 'selected' : '',
    ]);
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.llama-servers__btn')].find((b) => b.textContent?.trim() === label)!;
  const shown = () => mockTerminal.written.join('');
  return { fixture, host, electron, output, lifecycle, refresh, rows, button, shown };
}

describe('HealthLlamaServers', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists every local model with a run command and shows the first console', async () => {
    const { rows, host, shown } = await setup();
    expect(rows()).toEqual([
      ['Qwen', 'Off', 'light', 'selected'],
      ['Gemma', 'Off', 'light', ''],
    ]);
    expect(host.querySelector('.llama-servers__title')?.textContent).toBe('Qwen');
    expect(shown()).toBe('');
    expect(host.querySelector('.llama-servers__note')?.textContent).toContain('No output yet.');
  });

  it('shows what servers printed before the window opened, and opens on one that is up', async () => {
    const { rows, shown, host } = await setup([
      { modelId: 'conn-qwen', phase: 'off', streams: [{ stream: 'chat', text: 'qwen stopped earlier\n' }] },
      { modelId: 'conn-gemma', phase: 'running', streams: [{ stream: 'chat', text: 'gemma is serving\n' }] },
    ]);
    expect(rows()).toEqual([
      ['Qwen', 'Off', 'light', ''],
      ['Gemma', 'Running', 'light', 'selected'],
    ]);
    expect(shown()).toBe('gemma is serving\n');
    expect(host.querySelector('.llama-servers__note')).toBeNull();
  });

  it('switches the console when another server is picked', async () => {
    const { host, shown, rows, refresh } = await setup([
      { modelId: 'conn-qwen', phase: 'running', streams: [{ stream: 'chat', text: 'qwen log\n' }] },
      { modelId: 'conn-gemma', phase: 'running', streams: [{ stream: 'chat', text: 'gemma log\n' }] },
    ]);
    expect(shown()).toBe('qwen log\n');

    host.querySelectorAll<HTMLButtonElement>('.llama-servers__row')[1].click();
    await refresh();
    expect(rows().map((row) => row[3])).toEqual(['', 'selected']);
    expect(mockTerminal.reset).toHaveBeenCalled();
    expect(shown()).toBe('gemma log\n');
    expect(host.querySelector('.llama-servers__title')?.textContent).toBe('Gemma');
  });

  it('writes live output only to the console on screen, and keeps the rest for later', async () => {
    const { host, output, shown, refresh } = await setup();
    output.next({ modelId: 'conn-qwen', stream: 'chat', data: 'qwen line\n' });
    output.next({ modelId: 'conn-gemma', stream: 'chat', data: 'gemma line\n' });
    await refresh();
    expect(shown()).toBe('qwen line\n');

    host.querySelectorAll<HTMLButtonElement>('.llama-servers__row')[1].click();
    await refresh();
    expect(shown()).toBe('gemma line\n');
  });

  it('spins while a server loads, turns green when it runs, and starts each launch with a clean console', async () => {
    const { rows, lifecycle, output, shown, refresh } = await setup([
      { modelId: 'conn-qwen', phase: 'off', streams: [{ stream: 'chat', text: 'old run\n' }] },
    ]);
    expect(shown()).toBe('old run\n');

    lifecycle.next({ phase: 'starting', modelId: 'conn-qwen' });
    output.next({ modelId: 'conn-qwen', stream: 'chat', data: '[Starting llama-server]\n' });
    await refresh();
    expect(rows()[0]).toEqual(['Qwen', 'Loading', 'spinner', 'selected']);
    expect(shown()).toBe('[Starting llama-server]\n');

    lifecycle.next({ phase: 'downloading', modelId: 'conn-qwen' });
    await refresh();
    expect(rows()[0].slice(1, 3)).toEqual(['Loading', 'spinner']);

    lifecycle.next({ phase: 'running', modelId: 'conn-qwen' });
    await refresh();
    expect(rows()[0].slice(1, 3)).toEqual(['Running', 'light']);

    lifecycle.next({ phase: 'stopped', modelId: 'conn-qwen' });
    await refresh();
    expect(rows()[0].slice(1, 3)).toEqual(['Off', 'light']);
    // The console of a stopped server stays readable.
    expect(shown()).toContain('[Starting llama-server]');
  });

  it('gives an embedding server its own row once it prints', async () => {
    const { rows, output, refresh } = await setup();
    output.next({ modelId: 'conn-qwen', stream: 'embed', data: 'embedding ready\n' });
    await refresh();
    expect(rows().map((row) => row[0])).toEqual(['Qwen', 'Qwen · embeddings', 'Gemma']);
  });

  it('scrolls by button, and marks the way back once the view has left the newest line', async () => {
    const { button, host, refresh } = await setup([
      { modelId: 'conn-qwen', phase: 'running', streams: [{ stream: 'chat', text: 'many lines\n' }] },
    ]);
    const follow = () => host.querySelector('.llama-servers__follow')?.textContent?.trim();
    // A long console, viewed at its newest line.
    mockTerminal.buffer.active.baseY = 100;
    mockTerminal.buffer.active.viewportY = 100;
    button('Page up').disabled = false;
    button('Page up').click();
    await refresh();
    expect(mockTerminal.scrollPages).toHaveBeenCalledWith(-1);
    expect(follow()).toBe('Paused');
    expect(button('Latest').disabled).toBe(false);
    expect(button('Latest').classList.contains('is-attention')).toBe(true);
    expect(button('Top').disabled).toBe(false);

    button('Top').click();
    await refresh();
    expect(mockTerminal.scrollToTop).toHaveBeenCalled();
    expect(button('Top').disabled).toBe(true);
    expect(button('Page up').disabled).toBe(true);

    button('Page down').click();
    await refresh();
    expect(mockTerminal.scrollPages).toHaveBeenLastCalledWith(1);

    button('Latest').click();
    await refresh();
    expect(mockTerminal.scrollToBottom).toHaveBeenCalled();
    expect(follow()).toBe('Following');
    expect(button('Latest').disabled).toBe(true);
    expect(button('Page down').disabled).toBe(true);
    expect(button('Latest').classList.contains('is-attention')).toBe(false);
  });

  it('says where to add a local model when there is none', async () => {
    const { host, rows } = await setup([], { ...CONFIG, llmProviders: CONFIG.llmProviders.slice(0, 1) } as AppConfig);
    expect(rows()).toEqual([]);
    expect(host.querySelector('.llama-servers__empty')?.textContent?.trim()).toBe(
      'No local models with a run command. Add one in Sources.',
    );
    expect(host.querySelector('.llama-servers__title')?.textContent).toBe('No server');
  });
});
