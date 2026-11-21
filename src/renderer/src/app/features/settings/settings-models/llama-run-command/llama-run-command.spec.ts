import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CudaGpuDevice, GgufProfile, ManagedMtpHead } from '@shared/index';
import { ElectronService } from '../../../../core/electron.service';
import { lucideAppProviders } from '../../../../lucide-setup';
import { SettingsStore } from '../../settings/settings-store';
import { LlamaRunCommandComponent } from './llama-run-command';

const RTX5090: CudaGpuDevice = { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32607 };
const RTX5070TI: CudaGpuDevice = { cudaIndex: 1, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 16303 };
const BASE = 'llama-server --port {{PORT}} -m /m/gemma.gguf';
const NO_HEAD_PROFILE = { nextnLayers: 0, cacheLengths: [256] } as GgufProfile;

function setup(opts: {
  command?: string;
  gpus?: CudaGpuDevice[];
  head?: ManagedMtpHead | null;
  profile?: GgufProfile | null;
  totalRam?: number | null;
}) {
  const command = signal(opts.command ?? `${BASE} -dev CUDA1`);
  const store = {
    selectedLlamaCppManaged: () => ({ chatRunCommand: command(), embeddingRunCommand: '' }),
    selectedResolved: () => ({ optimizationPreset: 'generic', maxOutputTokens: 0 }),
    selectedModel: () => ({ id: 'm1' }),
    cudaGpus: signal(opts.gpus ?? [RTX5090, RTX5070TI]),
    managedGgufPath: () => '/m/gemma.gguf',
    managedMtpCompanionPath: () => '/m/mtp-gemma.gguf',
    managedDraftModelPath: () => null,
    managedGgufSizeBytes: () => null,
    managedGgufProfile: signal(opts.profile ?? null),
    managedDraftModelBytes: () => undefined,
    managedVramUsage: signal([]),
    managedGpuAdvice: () => ({ mode: 'single', primaryCudaIndex: 0, reason: '', tensorSplit: '31,16' }),
    managedGpuSplitRatioLabel: () => '31 GB : 16 GB',
    managedMtpHead: signal(opts.head ?? null),
    managedLlamaPortToken: '{{PORT}}',
    cudaGpuLabel: (gpu: CudaGpuDevice) => gpu.model,
    loadManagedGgufProfile: vi.fn(async () => null),
    setManagedChatRunCommand: vi.fn((next: string) => command.set(next)),
    onManagedGpuOffloadChange: vi.fn(),
  };
  const electron = {
    llamaServerNctx$: new Subject<Record<string, number>>(),
    llamaServerLifecycle$: new Subject<unknown>(),
    llamaServerFlagCatalog: vi.fn(async () => ({ ok: false as const, error: 'not asked' })),
    llamaServerLaunchedCommand: vi.fn(async () => ({ ok: true as const, command: null })),
    llamaServerVramUsage: vi.fn(async () => []),
    llamaServerGgufSize: vi.fn(async () => null),
    llamaServerTotalRam: vi.fn(async () => opts.totalRam ?? null),
    openFileDialog: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [LlamaRunCommandComponent],
    providers: [
      ...lucideAppProviders,
      { provide: SettingsStore, useValue: store },
      { provide: ElectronService, useValue: electron },
    ],
  });
  const fixture = TestBed.createComponent(LlamaRunCommandComponent);
  return { fixture, store, command };
}

async function render(fixture: ComponentFixture<LlamaRunCommandComponent>): Promise<HTMLElement> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const placementTrigger = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector('.run-placement__field .pill-select__trigger') as HTMLButtonElement;
/** Opens the placement picker and returns its options. */
async function placementOptions(fixture: ComponentFixture<LlamaRunCommandComponent>): Promise<HTMLButtonElement[]> {
  placementTrigger(await render(fixture)).click();
  await render(fixture);
  return [...document.querySelectorAll<HTMLButtonElement>('.pill-select__option')];
}
const optionLabels = (options: HTMLButtonElement[]): string[] => options.map((o) => (o.textContent ?? '').trim());
const offerButton = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector('.run-command__notice--offer button');

beforeEach(() => TestBed.resetTestingModule());

describe('GPU placement', () => {
  it('lists every card by name, then the split and all GPUs', async () => {
    const { fixture } = setup({});
    expect(optionLabels(await placementOptions(fixture))).toEqual([
      'RTX 5090 only (recommended)',
      'RTX 5070 Ti only',
      'Split across RTX 5090 + RTX 5070 Ti',
      'All GPUs, llama-server decides',
    ]);
  });

  it('shows the card the command pins', async () => {
    const { fixture } = setup({ command: `${BASE} -dev CUDA1` });
    expect(placementTrigger(await render(fixture)).textContent?.trim()).toBe('RTX 5070 Ti only');
  });

  it('writes the card that was picked', async () => {
    const { fixture, store } = setup({});
    (await placementOptions(fixture))[0]?.click();
    expect(store.onManagedGpuOffloadChange).toHaveBeenCalledWith('single', 0);
    (await placementOptions(fixture))[3]?.click();
    expect(store.onManagedGpuOffloadChange).toHaveBeenLastCalledWith('auto', undefined);
  });

  it('does not offer a split with one card', async () => {
    const { fixture } = setup({ gpus: [RTX5070TI] });
    expect(optionLabels(await placementOptions(fixture))).toEqual(['RTX 5070 Ti only', 'All GPUs, llama-server decides']);
  });

  it('names cards that share a model by their CUDA index', async () => {
    const twin: CudaGpuDevice = { ...RTX5070TI, cudaIndex: 2 };
    const { fixture } = setup({ gpus: [RTX5070TI, twin] });
    expect(optionLabels(await placementOptions(fixture))).toContain('Split across RTX 5070 Ti (CUDA1) + RTX 5070 Ti (CUDA2)');
  });

  it('shows the flags the placement writes', async () => {
    const split = setup({ command: `${BASE} -dev CUDA0,CUDA1 --tensor-split 27,21 --main-gpu 0` });
    const flags = (el: HTMLElement) => el.querySelector('.run-placement__flags')?.textContent?.trim();
    expect(flags(await render(split.fixture))).toBe('Sets-dev CUDA0,CUDA1  --tensor-split 27,21  --main-gpu 0');
    TestBed.resetTestingModule();
    const all = setup({ command: BASE });
    expect(flags(await render(all.fixture))).toContain('No GPU flags');
  });
});

describe('the model strip', () => {
  const SPLIT = `${BASE} -dev CUDA0,CUDA1 --tensor-split 27,21`;
  const handle = (el: HTMLElement) => el.querySelector('.run-strip__handle') as HTMLInputElement | null;

  it('shows a split as shares when the model size is unknown, with a handle on the boundary', async () => {
    const { fixture } = setup({ command: SPLIT });
    const el = await render(fixture);
    const labels = [...el.querySelectorAll('.run-strip__labels span')].map((s) => s.textContent?.trim());
    expect(labels).toEqual(['RTX 5090 56%', 'RTX 5070 Ti 44%']);
    expect(handle(el)?.value).toBe('27');
    expect(handle(el)?.max).toBe('47');
  });

  it('writes the split the handle is dragged to', async () => {
    const { fixture, command } = setup({ command: SPLIT });
    const input = handle(await render(fixture)) as HTMLInputElement;
    input.value = '30';
    input.dispatchEvent(new Event('input'));
    expect(command()).toContain('--tensor-split 30,18');
  });

  it('offers a reset only when the split is off the VRAM ratio', async () => {
    const off = setup({ command: SPLIT });
    const reset = (el: HTMLElement) => el.querySelector('.run-strip__reset') as HTMLButtonElement | null;
    reset(await render(off.fixture))?.click();
    expect(off.store.onManagedGpuOffloadChange).toHaveBeenCalledWith('split');
    TestBed.resetTestingModule();
    const even = setup({ command: `${BASE} -dev CUDA0,CUDA1 --tensor-split 32,16` });
    expect(reset(await render(even.fixture))).toBeNull();
  });

  it('is not shown on one card with no model size', async () => {
    const { fixture } = setup({ command: `${BASE} -dev CUDA1` });
    expect((await render(fixture)).querySelector('.run-strip')).toBeNull();
  });
});

describe('MTP offer', () => {
  const companion: ManagedMtpHead = { companionPath: '/m/mtp-gemma.gguf' };

  it('offers a head on one card, and writes the flags only when asked', async () => {
    const { fixture, store, command } = setup({ head: companion });
    const el = await render(fixture);
    expect(el.querySelector('.run-command__notice--offer')?.textContent).toContain('mtp-gemma.gguf');
    expect(store.setManagedChatRunCommand).not.toHaveBeenCalled();
    offerButton(el)?.click();
    expect(command()).toBe(`${BASE} -dev CUDA1 --spec-type draft-mtp --spec-draft-model /m/mtp-gemma.gguf --spec-draft-n-max 4`);
    expect(offerButton(await render(fixture))).toBeNull();
  });

  it('offers a head inside the model, with no draft model', async () => {
    const { fixture, command } = setup({ head: { companionPath: null } });
    const el = await render(fixture);
    expect(el.querySelector('.run-command__notice--offer')?.textContent).toContain('inside it');
    offerButton(el)?.click();
    expect(command()).toBe(`${BASE} -dev CUDA1 --spec-type draft-mtp --spec-draft-n-max 4`);
  });

  it('is not made on a split, or on every card of several', async () => {
    const split = setup({ head: companion, command: `${BASE} -dev CUDA0,CUDA1 --tensor-split 27,21` });
    expect(offerButton(await render(split.fixture))).toBeNull();
    TestBed.resetTestingModule();
    const all = setup({ head: companion, command: BASE });
    expect(offerButton(await render(all.fixture))).toBeNull();
  });

  it('is made when the only card is used by default', async () => {
    const { fixture } = setup({ head: companion, command: BASE, gpus: [RTX5070TI] });
    expect(offerButton(await render(fixture))).not.toBeNull();
  });

  it('is not made without a head, or when the command already uses one', async () => {
    const none = setup({ head: null });
    expect(offerButton(await render(none.fixture))).toBeNull();
    TestBed.resetTestingModule();
    const on = setup({ head: companion, command: `${BASE} -dev CUDA1 --spec-type draft-mtp` });
    expect(offerButton(await render(on.fixture))).toBeNull();
  });
});

describe('the checks that need the header', () => {
  it('reads the header of the model and of its head', async () => {
    const { fixture, store } = setup({});
    await render(fixture);
    expect(store.loadManagedGgufProfile).toHaveBeenCalledWith('/m/gemma.gguf');
    expect(store.loadManagedGgufProfile).toHaveBeenCalledWith('/m/mtp-gemma.gguf');
  });

  it('sizes each card from the header, with no file size to go on', async () => {
    const { fixture, store } = setup({});
    expect((await render(fixture)).querySelector('.run-vram')).toBeNull();
    store.managedGgufProfile.set({
      contextTrain: 4096,
      embeddingOut: 4096,
      nextnLayers: 0,
      tensorBytes: 4 * 1024 ** 3,
      hostBytes: 0,
      headBytes: 0,
      recurrentStateBytes: 0,
      fullKeys: 8192,
      fullValues: 8192,
      maxFullKey: 1024,
      swaKeys: 0,
      swaValues: 0,
      slidingWindow: 0,
      cacheLengths: [256],
    });
    const gauges = [...(await render(fixture)).querySelectorAll('.run-gauge')].map((g) => g.textContent ?? '');
    expect(gauges).toHaveLength(2);
    expect(gauges[0]).toContain('Not used');
    expect(gauges[1]).toMatch(/RTX 5070 Ti.*About [\d.]+ of 15\.9 GB/);
    expect((await render(fixture)).querySelector('.run-strip__labels')?.textContent).toMatch(/RTX 5070 Ti [\d.]+ GB/);
  });

  it('marks draft-mtp invalid on a model with no head once the header is read', async () => {
    const { fixture, store } = setup({ command: `${BASE} --spec-type draft-mtp`, profile: null });
    const row = (el: HTMLElement) => el.querySelector('.run-flag[data-flag="--spec-type"]');
    expect(row(await render(fixture))?.getAttribute('data-status')).toBe('used');
    store.managedGgufProfile.set(NO_HEAD_PROFILE);
    const el = await render(fixture);
    expect(row(el)?.getAttribute('data-status')).toBe('invalid');
    expect(row(el)?.textContent).toContain('no MTP head');
  });
});

describe('the flags Clara sends on every request', () => {
  it('marks -n a fallback at Max output 0 too, where local steps send the default limit', async () => {
    const { fixture } = setup({ command: `${BASE} -n 50000` });
    const el = await render(fixture);
    const row = el.querySelector('[data-flag="-n"]');
    expect(row?.getAttribute('data-status')).toBe('request');
    expect(row?.textContent).toContain('Max output');
  });
});

describe('the command Clara starts', () => {
  it('shows the context floor when the command sets no -c', async () => {
    const { fixture } = setup({ command: BASE });
    const el = await render(fixture);
    expect(el.querySelector('.run-command__start code')?.textContent).toContain('--fit-ctx 16384');
    expect(el.querySelector('.run-flag--added[data-flag="--fit-ctx"]')?.textContent).toContain('shrink');
  });

  it('shows no floor when the command sets a -c', async () => {
    const { fixture } = setup({ command: `${BASE} -c 65536` });
    const el = await render(fixture);
    expect(el.querySelector('.run-command__start code')?.textContent).not.toContain('--fit-ctx');
  });

  it('shows the prompt cache limit on a small machine', async () => {
    const { fixture } = setup({ totalRam: 16 * 1024 ** 3 });
    const el = await render(fixture);
    expect(el.querySelector('.run-command__start code')?.textContent).toContain('--cache-ram 2048');
    expect(el.querySelector('.run-flag--added[data-flag="--cache-ram"]')?.textContent).toContain('24 GB');
  });

  it('shows no limit on a bigger machine', async () => {
    const { fixture } = setup({ totalRam: 32 * 1024 ** 3 });
    const el = await render(fixture);
    expect(el.querySelector('.run-command__start code')?.textContent).not.toContain('--cache-ram');
  });
});
