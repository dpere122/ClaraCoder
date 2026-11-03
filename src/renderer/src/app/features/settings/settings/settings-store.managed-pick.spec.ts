import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NgxSpinnerService } from 'ngx-spinner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildManagedChatStartCommand,
  diffLlamaCommands,
  inferContextWindowTokens,
  parseManagedLlamaContextSize,
  PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
  type AppConfig,
  type CudaGpuDevice,
  type GgufProfile,
  type GpuVramCardUsage,
  type HuggingFaceModelFile,
  type LlamaCppManaged,
  type LlmProviderConfig,
  type ModelManagerFileEntry,
} from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedPromptDialogService } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog.service';
import { SettingsThemesStore } from '../settings-themes/settings-themes-store';
import { SettingsStore } from './settings-store';

const SWIFT = '/models/models--ajgazin--Swift/snapshots/abc/Swift-1.5-Qwen3.8-27B-Uncensored-Dynamic-MTP-UD-Q6_K_XL.gguf';
const MIMO = '/models/mimo/MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf';
const GEMMA = '/models/gemma/gemma-4-12B-it-Q4_0.gguf';
const GEMMA_HEAD = '/models/gemma/mtp-gemma-4-12B-it-Q4_0.gguf';
const SWIFT_HUB = '/models/models--ajgazin--Swift';

/** The user's run command on the 5090 and 5070 Ti, as saved. */
const PRESET =
  `llama-server --host 127.0.0.1 --port {{PORT}} --jinja -m ${SWIFT} -c 128000 -np 1 --cache-ram -1 -fa on ` +
  '-ctk q8_0 -ctv q8_0 --metrics --no-webui --spec-draft-n-max 4 --spec-type draft-mtp -dev CUDA0,CUDA1 ' +
  '--tensor-split 27,21 --main-gpu 0 -ngl auto --no-mmproj --load-mode auto';

const PROFILE_BASE: GgufProfile = {
  contextTrain: 262144,
  embeddingOut: 4096,
  nextnLayers: 0,
  tensorBytes: 9516533760,
  hostBytes: 1080688640,
  headBytes: 0,
  recurrentStateBytes: 52690944,
  fullKeys: 8192,
  fullValues: 8192,
  maxFullKey: 1024,
  swaKeys: 0,
  swaValues: 0,
  slidingWindow: 0,
  cacheLengths: [256],
};
const PROFILES: Readonly<Record<string, GgufProfile>> = {
  [MIMO]: PROFILE_BASE,
  [SWIFT]: {
    ...PROFILE_BASE,
    embeddingOut: 5120,
    nextnLayers: 1,
    tensorBytes: 25288065024,
    hostBytes: 1042944000,
    headBytes: 351008768,
    recurrentStateBytes: 156893184,
    fullKeys: 16384,
    fullValues: 16384,
  },
  [GEMMA]: {
    ...PROFILE_BASE,
    embeddingOut: 3840,
    tensorBytes: 7203849728,
    hostBytes: 0,
    recurrentStateBytes: 0,
    fullKeys: 4096,
    fullValues: 4096,
    maxFullKey: 512,
    swaKeys: 81920,
    swaValues: 81920,
    slidingWindow: 1024,
    cacheLengths: [512, 256],
  },
  [GEMMA_HEAD]: {
    ...PROFILE_BASE,
    embeddingOut: 3840,
    nextnLayers: 4,
    tensorBytes: 237922432,
    hostBytes: 0,
    recurrentStateBytes: 0,
  },
};

const GPUS: CudaGpuDevice[] = [
  { cudaIndex: 0, model: 'NVIDIA GeForce RTX 5090', memoryTotalMb: 32607 },
  { cudaIndex: 1, model: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 16303 },
];
const USAGE: GpuVramCardUsage[] = [
  { cudaIndex: 0, dedicatedMb: 11050, otherMb: 11050 },
  { cudaIndex: 1, dedicatedMb: 0, otherMb: 0 },
];

const loose = (absolutePath: string): ModelManagerFileEntry => ({
  fileName: absolutePath.split('/').pop() as string,
  absolutePath,
  sizeBytes: 1,
  modifiedMs: 0,
  source: 'custom',
});
const INVENTORY: ModelManagerFileEntry[] = [
  {
    fileName: 'models--ajgazin--Swift',
    absolutePath: SWIFT_HUB,
    sizeBytes: 1,
    modifiedMs: 0,
    source: 'custom',
    entryKind: 'hubRepo',
    ggufAbsolutePath: SWIFT,
  },
  loose(MIMO),
  loose(GEMMA),
  loose(GEMMA_HEAD),
];

function setup(
  managed: Partial<LlamaCppManaged> & { chatRunCommand: string },
  opts: { profiles?: Readonly<Record<string, GgufProfile>>; gpus?: CudaGpuDevice[]; usage?: GpuVramCardUsage[] } = {},
) {
  const profiles = opts.profiles ?? PROFILES;
  const electron = {
    llamaServerGgufProfile: vi.fn(async ({ path }: { path: string }): Promise<GgufProfile | null> => profiles[path] ?? null),
    llamaServerVramUsage: vi.fn(async () => opts.usage ?? USAGE),
    llamaServerGgufSize: vi.fn(async (): Promise<number | null> => null),
    modelManagerListCustomModels: vi.fn(async () => ({ ok: true, models: store.modelManagerCustomModels() })),
    saveConfig: vi.fn(async (_config: AppConfig): Promise<unknown> => SAVED),
  };
  TestBed.configureTestingModule({
    providers: [
      SettingsStore,
      { provide: ElectronService, useValue: electron },
      { provide: ThemedConfirmDialogService, useValue: {} },
      { provide: ThemedPromptDialogService, useValue: {} },
      { provide: NgxSpinnerService, useValue: { show: vi.fn(), hide: vi.fn() } },
      { provide: ThemeEngineService, useValue: { library: signal([]) } },
      {
        provide: SettingsThemesStore,
        useValue: {
          attach: vi.fn(),
          syncSelectionFromHost: vi.fn(),
          cancelPreview: vi.fn(),
          persistIfDirty: vi.fn(async () => undefined),
          afterPersist: vi.fn(),
        },
      },
    ],
  });
  const store = TestBed.inject(SettingsStore);
  store.llmProviders.set([
    {
      id: PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
      name: 'Local Model',
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: {},
      models: [
        {
          id: 'm1',
          name: 'model',
          model: 'local-model',
          contextWindowTokens: 8192,
          llamaCppManaged: { embeddingRunCommand: '', ...managed },
        },
      ],
    } as unknown as LlmProviderConfig,
  ]);
  store.selectedModelId.set('m1');
  store.cudaGpus.set(opts.gpus ?? GPUS);
  store.modelManagerCustomDir.set('/models');
  store.modelManagerCustomModels.set(INVENTORY);
  return { store, electron };
}

/** What the pick's header read and plan have written, once they've settled. */
async function settled(store: SettingsStore): Promise<LlamaCppManaged> {
  await new Promise((resolve) => setTimeout(resolve));
  return store.selectedLlamaCppManaged();
}

/** What the save IPC hands back, and all that a save reads from it. */
const SAVED = { workspaces: [], currentWorkspaceId: null };

const flagValue = (command: string, flag: string): string | undefined => {
  const tokens = command.split(/\s+/);
  const at = tokens.indexOf(flag);
  return at < 0 ? undefined : tokens[at + 1];
};

beforeEach(() => TestBed.resetTestingModule());

describe('re-picking the 5090 preset', () => {
  const expectPresetFlags = (command: string): void => {
    expect(flagValue(command, '-dev')).toBe('CUDA0,CUDA1');
    expect(flagValue(command, '--tensor-split')).toBe('27,21');
    expect(flagValue(command, '--cache-ram')).toBe('-1');
    expect(flagValue(command, '-c')).toBe('128000');
    expect(flagValue(command, '--main-gpu')).toBe('0');
    expect(flagValue(command, '-np')).toBe('1');
    expect(flagValue(command, '--load-mode')).toBe('auto');
  };

  it('with the same model leaves every flag as it was, the moment it happens and after the header read', async () => {
    const { store } = setup({ chatRunCommand: PRESET });
    store.onManagedInventoryPick(`hub:${SWIFT_HUB}`);
    const immediately = store.selectedLlamaCppManaged().chatRunCommand;
    expect(diffLlamaCommands(PRESET, immediately, null)).toEqual([]);
    const { chatRunCommand, autoTuned } = await settled(store);
    expect(chatRunCommand).toBe(immediately);
    expect(autoTuned).toBeUndefined();
    expect(flagValue(chatRunCommand, '--spec-type')).toBe('draft-mtp');
    expectPresetFlags(chatRunCommand);
  });

  it('with the same model keeps draft-mtp even when the header cannot be read', async () => {
    const { store } = setup({ chatRunCommand: PRESET }, { profiles: {} });
    store.onManagedInventoryPick(`hub:${SWIFT_HUB}`);
    const { chatRunCommand } = await settled(store);
    expect(diffLlamaCommands(PRESET, chatRunCommand, null)).toEqual([]);
  });

  it('moving to a model with no head drops only draft-mtp', async () => {
    const { store } = setup({ chatRunCommand: PRESET });
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const { chatRunCommand } = await settled(store);
    const changed = diffLlamaCommands(PRESET, chatRunCommand, null);
    expect(changed).toEqual(
      expect.arrayContaining([
        { flag: '-m', from: SWIFT, to: MIMO },
        { flag: '--spec-type', from: 'draft-mtp', to: null },
      ]),
    );
    expect(changed).toHaveLength(2);
    expectPresetFlags(chatRunCommand);
    expect(flagValue(chatRunCommand, '--spec-draft-n-max')).toBe('4');
  });

  it('moving to a model with no head stays that way when the header cannot be read', async () => {
    const { store } = setup({ chatRunCommand: PRESET }, { profiles: {} });
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const { chatRunCommand } = await settled(store);
    expect(chatRunCommand).not.toContain('draft-mtp');
    expectPresetFlags(chatRunCommand);
  });

  it('moving to a model with a companion head restores draft-mtp on that head', async () => {
    const { store } = setup({ chatRunCommand: PRESET });
    store.onManagedInventoryPick(`gguf:${GEMMA}`);
    // The old head can't serve the new model, not even while the header is being read.
    expect(store.selectedLlamaCppManaged().chatRunCommand).not.toContain('draft-mtp');
    const { chatRunCommand } = await settled(store);
    expect(flagValue(chatRunCommand, '--spec-type')).toBe('draft-mtp');
    expect(flagValue(chatRunCommand, '--spec-draft-model')).toBe(GEMMA_HEAD);
    expect(flagValue(chatRunCommand, '--spec-draft-n-max')).toBe('4');
    expectPresetFlags(chatRunCommand);
  });

  it('moving to it from another model with a head brings draft-mtp along', async () => {
    const { store } = setup({ chatRunCommand: PRESET.replace(SWIFT, '/models/other-with-head.gguf') });
    store.onManagedInventoryPick(`hub:${SWIFT_HUB}`);
    const { chatRunCommand } = await settled(store);
    expect(diffLlamaCommands(PRESET, chatRunCommand, null)).toEqual([]);
  });

  it('starts exactly as saved, however often it is picked', async () => {
    const { store } = setup({ chatRunCommand: PRESET });
    expect(buildManagedChatStartCommand(PRESET, 'qwen', 'win32', 16 * 1024 ** 3)).toBe(PRESET);
    store.onManagedInventoryPick(`hub:${SWIFT_HUB}`);
    const once = (await settled(store)).chatRunCommand;
    store.onManagedInventoryPick(`hub:${SWIFT_HUB}`);
    const twice = await settled(store);
    expect(twice.chatRunCommand).toBe(once);
    expect(twice.autoTuned).toBeUndefined();
    expect(store.selectedModel()?.contextWindowTokens).toBe(128000);
    for (const ram of [16, 64]) {
      const started = buildManagedChatStartCommand(once, 'qwen', 'win32', ram * 1024 ** 3);
      expect(started).toBe(once);
      expect(diffLlamaCommands(PRESET, started, null)).toEqual([]);
    }
  });

  it('Reset defaults removes the custom flags, draft-mtp with them', async () => {
    const { store } = setup({ chatRunCommand: PRESET });
    store.resetManagedToRecommended();
    const { chatRunCommand } = await settled(store);
    expect(chatRunCommand).not.toContain('draft-mtp');
    expect(chatRunCommand).not.toContain('--cache-ram');
    expect(chatRunCommand).not.toContain('--load-mode');
    expect(flagValue(chatRunCommand, '-c')).toBe('128000');
    expect(flagValue(chatRunCommand, '--tensor-split')).toBe('27,21');
  });
});

describe('a hand-written -c, -dev and --tensor-split', () => {
  const hand = `llama-server --port {{PORT}} -m ${MIMO} -c 50000 -dev CUDA1,CUDA0 --tensor-split 3,1`;

  it('survive a pick with a usable plan, a stale plan on file, and a -c that would not fit', async () => {
    for (const autoTuned of [undefined, { c: 131072, ctk: 'q8_0', ctv: 'q8_0' }]) {
      TestBed.resetTestingModule();
      const { store } = setup({ chatRunCommand: hand, ...(autoTuned ? { autoTuned } : {}) });
      store.onManagedInventoryPick(`gguf:${GEMMA}`);
      const { chatRunCommand } = await settled(store);
      expect(flagValue(chatRunCommand, '-c')).toBe('50000');
      expect(flagValue(chatRunCommand, '-dev')).toBe('CUDA1,CUDA0');
      expect(flagValue(chatRunCommand, '--tensor-split')).toBe('3,1');
      expect(chatRunCommand).not.toContain('-ctk');
    }
  });

  it('hold on a card the model does not fit', async () => {
    const big: GgufProfile = { ...PROFILE_BASE, tensorBytes: 60 * 1024 ** 3, hostBytes: 0 };
    const { store } = setup({ chatRunCommand: hand }, { profiles: { [GEMMA]: big } });
    store.onManagedInventoryPick(`gguf:${GEMMA}`);
    const { chatRunCommand } = await settled(store);
    expect(flagValue(chatRunCommand, '-c')).toBe('50000');
    expect(flagValue(chatRunCommand, '--tensor-split')).toBe('3,1');
  });
});

describe('a fresh pick', () => {
  const FRESH = 'llama-server --host 127.0.0.1 --port {{PORT}} --jinja --no-webui -np 1 -hf org/model:Q4_0';

  it('writes the plan, remembers it, and keeps the profile window in step', async () => {
    const { store, electron } = setup({ chatRunCommand: FRESH }, { usage: [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 0 }] });
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    expect(parseManagedLlamaContextSize(store.selectedLlamaCppManaged().chatRunCommand)).toBeNull();
    const { chatRunCommand, autoTuned } = await settled(store);
    expect(electron.llamaServerGgufProfile).toHaveBeenCalledWith({ path: MIMO });
    expect(autoTuned).toEqual({ c: 131072, ctk: 'q8_0', ctv: 'q8_0' });
    expect(flagValue(chatRunCommand, '-c')).toBe('131072');
    expect(flagValue(chatRunCommand, '-ctk')).toBe('q8_0');
    expect(store.selectedModel()?.contextWindowTokens).toBe(131072);
    expect(store.settingsDirty()).toBe(true);
    expect(store.managedVramUsage()).toEqual([{ cudaIndex: 0, dedicatedMb: 0, otherMb: 0 }]);
  });

  it('gets no MTP flags on its own, whatever head the model has', async () => {
    for (const pick of [`gguf:${GEMMA}`, `hub:${SWIFT_HUB}`]) {
      TestBed.resetTestingModule();
      const { store } = setup({ chatRunCommand: FRESH });
      store.onManagedInventoryPick(pick);
      const { chatRunCommand } = await settled(store);
      expect(chatRunCommand).not.toContain('--spec-type');
      expect(chatRunCommand).not.toContain('--spec-draft-model');
    }
  });

  it('for -hf gets no plan, and reads no header', async () => {
    const { store, electron } = setup({ chatRunCommand: 'llama-server --port {{PORT}} -m /old.gguf' });
    store.onManagedInventoryPick('hf:org/model:Q4_0');
    const { chatRunCommand, autoTuned } = await settled(store);
    expect(electron.llamaServerGgufProfile).not.toHaveBeenCalled();
    expect(flagValue(chatRunCommand, '-hf')).toBe('org/model:Q4_0');
    expect(parseManagedLlamaContextSize(chatRunCommand)).toBeNull();
    expect(chatRunCommand).not.toContain('-ctk');
    expect(autoTuned).toBeUndefined();
  });

  it('replaces the last model\'s plan with this model\'s', async () => {
    const big: GgufProfile = { ...PROFILE_BASE, tensorBytes: 60 * 1024 ** 3, hostBytes: 0 };
    const { store } = setup(
      {
        chatRunCommand: 'llama-server --port {{PORT}} -m /old.gguf -c 131072 -ctk q8_0 -ctv q8_0',
        autoTuned: { c: 131072, ctk: 'q8_0', ctv: 'q8_0' },
      },
      { profiles: { [MIMO]: big } },
    );
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const { chatRunCommand, autoTuned } = await settled(store);
    expect(parseManagedLlamaContextSize(chatRunCommand)).toBeNull();
    expect(chatRunCommand).not.toContain('-ctk');
    expect(autoTuned).toBeUndefined();
    expect(store.selectedModel()?.contextWindowTokens).not.toBe(131072);
  });

  it('with no plan still starts with room for the prompt, and with one needs no floor', async () => {
    const start = (command: string): string => buildManagedChatStartCommand(command, 'generic', 'posix');
    const big: GgufProfile = { ...PROFILE_BASE, tensorBytes: 60 * 1024 ** 3, hostBytes: 0 };
    const { store } = setup({ chatRunCommand: FRESH }, { profiles: { [MIMO]: big } });
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const unplanned = await settled(store);
    expect(unplanned.autoTuned).toBeUndefined();
    expect(parseManagedLlamaContextSize(unplanned.chatRunCommand)).toBeNull();
    expect(unplanned.chatRunCommand).not.toContain('--fit-ctx');
    expect(flagValue(start(unplanned.chatRunCommand), '--fit-ctx')).toBe('16384');

    TestBed.resetTestingModule();
    const planned = setup({ chatRunCommand: FRESH }).store;
    planned.onManagedInventoryPick(`gguf:${MIMO}`);
    const { chatRunCommand, autoTuned } = await settled(planned);
    expect(autoTuned?.c).toBeGreaterThan(0);
    expect(start(chatRunCommand)).not.toContain('--fit-ctx');
  });

  it('leaves a command the user edited during the read', async () => {
    const { store } = setup({ chatRunCommand: FRESH });
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const edited = `${store.selectedLlamaCppManaged().chatRunCommand} -c 4096`;
    store.setManagedChatRunCommand(edited);
    const { chatRunCommand, autoTuned } = await settled(store);
    expect(chatRunCommand).toBe(edited);
    expect(autoTuned).toBeUndefined();
  });

  it('leaves the model the user moved to during the read', async () => {
    const { store } = setup({ chatRunCommand: FRESH });
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    store.selectedModelId.set(null);
    await settled(store);
    store.selectedModelId.set('m1');
    expect(parseManagedLlamaContextSize(store.selectedLlamaCppManaged().chatRunCommand)).toBeNull();
  });
});

describe('the Local model picker', () => {
  it('does not offer an MTP head as a model', () => {
    const { store } = setup({ chatRunCommand: PRESET });
    expect(store.managedInventoryModels().map((m) => m.fileName)).toEqual([
      'models--ajgazin--Swift',
      'MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf',
      'gemma-4-12B-it-Q4_0.gguf',
    ]);
    expect(store.modelManagerCustomModels()).toHaveLength(4);
  });

  it('does not offer a draft head as a model, but keeps a hub folder named like one', () => {
    const { store } = setup({ chatRunCommand: PRESET });
    const hub: ModelManagerFileEntry = { ...loose('/models/models--z-lab--Qwen3-4B-DFlash'), entryKind: 'hubRepo' };
    store.modelManagerCustomModels.set([
      loose(MIMO),
      loose('/models/qwen/dflash-Qwen3.8-27B-Q4_0.gguf'),
      loose('/models/qwen/laguna-s-2.1-DFlash-BF16.gguf'),
      loose('/models/gpt/eagle3-gpt-oss-20b-Q8_0.gguf'),
      hub,
    ]);
    expect(store.managedInventoryModels().map((m) => m.fileName)).toEqual([
      'MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf',
      'models--z-lab--Qwen3-4B-DFlash',
    ]);
  });
});

describe('the Local model picker and a projector', () => {
  it('does not offer a vision projector as a model', () => {
    const { store } = setup({ chatRunCommand: PRESET });
    store.modelManagerCustomModels.set([loose(MIMO), loose('/models/gemma/mmproj-gemma-4-12B-it-bf16.gguf')]);
    expect(store.managedInventoryModels().map((m) => m.fileName)).toEqual(['MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf']);
  });
});

describe('Use in Models', () => {
  const HAND = `llama-server --port {{PORT}} -m ${MIMO} -c 50000 -dev CUDA1 --no-mmap --cache-ram 4096 -t 12 --seed 7`;
  const hubRow = INVENTORY[0] as ModelManagerFileEntry;

  it('on the selected model changes nothing, as the Local model picker does', async () => {
    const { store } = setup({ chatRunCommand: PRESET });
    store.useCustomModelInModels(hubRow);
    const { chatRunCommand, autoTuned } = await settled(store);
    expect(diffLlamaCommands(PRESET, chatRunCommand, null)).toEqual([]);
    expect(autoTuned).toBeUndefined();
    expect(store.selectedSettingsTab()).toBe('models');
    expect(store.activeLlmModelId()).toBe('m1');
  });

  it('on the selected repo with no local file keeps the custom flags too', async () => {
    const hfPreset = PRESET.replace(`-m ${SWIFT}`, '-hf ajgazin/Swift');
    const { store } = setup({ chatRunCommand: hfPreset });
    store.useCustomModelInModels({ ...hubRow, ggufAbsolutePath: undefined });
    const { chatRunCommand } = await settled(store);
    expect(diffLlamaCommands(hfPreset, chatRunCommand, null)).toEqual([]);
  });

  it('moving to a model with a companion head matches the Local model picker, draft-mtp on that head', async () => {
    const { store } = setup({ chatRunCommand: PRESET });
    store.useCustomModelInModels(loose(GEMMA));
    const used = (await settled(store)).chatRunCommand;
    expect(flagValue(used, '--spec-type')).toBe('draft-mtp');
    expect(flagValue(used, '--spec-draft-model')).toBe(GEMMA_HEAD);
    expect(flagValue(used, '--cache-ram')).toBe('-1');
    expect(flagValue(used, '--load-mode')).toBe('auto');
    TestBed.resetTestingModule();
    const picker = setup({ chatRunCommand: PRESET }).store;
    picker.onManagedInventoryPick(`gguf:${GEMMA}`);
    expect((await settled(picker)).chatRunCommand).toBe(used);
  });

  it('on a downloaded quant keeps the hand-written flags', async () => {
    const { store } = setup({ chatRunCommand: HAND });
    const file: HuggingFaceModelFile = { fileName: 'gemma-4-12B-it-Q4_0.gguf', quant: 'Q4_0', sizeBytes: 1 };
    store.modelManagerHfDownloaded.set({ [`ggml-org/gemma-4-12B-it-GGUF/${file.fileName}`]: GEMMA });
    store.useHfQuantInModels('ggml-org/gemma-4-12B-it-GGUF', file);
    const { chatRunCommand } = await settled(store);
    expect(flagValue(chatRunCommand, '-m')).toBe(GEMMA);
    expect(flagValue(chatRunCommand, '--cache-ram')).toBe('4096');
    expect(flagValue(chatRunCommand, '-t')).toBe('12');
    expect(flagValue(chatRunCommand, '--seed')).toBe('7');
    expect(chatRunCommand).toContain('--no-mmap');
  });

  it('on a downloaded quant gets the preset its file name says, as the Local model picker does', async () => {
    const { store } = setup({ chatRunCommand: HAND });
    const file: HuggingFaceModelFile = { fileName: 'gemma-4-12B-it-Q4_0.gguf', quant: 'Q4_0', sizeBytes: 1 };
    store.modelManagerHfDownloaded.set({ [`ggml-org/gemma-4-12B-it-GGUF/${file.fileName}`]: GEMMA });
    store.useHfQuantInModels('ggml-org/gemma-4-12B-it-GGUF', file);
    await settled(store);
    expect(store.selectedModel()?.optimizationPreset).toBe('gemma');
  });

  it('on an -hf id keeps the hand-written flags', async () => {
    const { store } = setup({ chatRunCommand: HAND });
    store.useHfModelInModels('org/model:Q4_0');
    const { chatRunCommand } = await settled(store);
    expect(flagValue(chatRunCommand, '-hf')).toBe('org/model:Q4_0');
    expect(flagValue(chatRunCommand, '--cache-ram')).toBe('4096');
    expect(chatRunCommand).toContain('--no-mmap');
  });

  it('leaves Reset defaults as the one way to drop them', async () => {
    const { store } = setup({ chatRunCommand: HAND });
    store.resetManagedToRecommended();
    const { chatRunCommand } = await settled(store);
    expect(chatRunCommand).not.toContain('--cache-ram');
    expect(chatRunCommand).not.toContain('--no-mmap');
  });
});

describe('what an earlier plan wrote', () => {
  const autoTuned = { c: 45056, ctk: 'q8_0', ctv: 'q8_0' };
  const TUNED = `llama-server --port {{PORT}} -m ${MIMO} -c 45056 -ctk q8_0 -ctv q8_0 --no-mmap`;

  const expectPlanGone = (managed: LlamaCppManaged, store: SettingsStore): void => {
    expect(parseManagedLlamaContextSize(managed.chatRunCommand)).toBeNull();
    expect(managed.chatRunCommand).not.toContain('-ctk');
    expect(managed.chatRunCommand).not.toContain('-ctv');
    expect(managed.chatRunCommand).toContain('--no-mmap');
    expect(managed.autoTuned).toBeUndefined();
    expect(store.selectedModel()?.contextWindowTokens).not.toBe(45056);
  };

  it('stays behind on an -hf pick, in the command and the window', async () => {
    const { store } = setup({ chatRunCommand: TUNED, autoTuned });
    store.onManagedInventoryPick('hf:org/model:Q4_0');
    expect(store.selectedModel()?.contextWindowTokens).toBe(inferContextWindowTokens('org/model:Q4_0', 'llamacpp'));
    expectPlanGone(await settled(store), store);
  });

  it('stays behind on a hub row with several quants', async () => {
    const { store } = setup({ chatRunCommand: TUNED, autoTuned });
    store.modelManagerCustomModels.set([{ ...loose('/models/models--org--repo'), entryKind: 'hubRepo' }]);
    store.onManagedInventoryPick('hub:/models/models--org--repo');
    const managed = await settled(store);
    expect(flagValue(managed.chatRunCommand, '-hf')).toBe('org/repo');
    expectPlanGone(managed, store);
  });

  it('has left already when the next model is saved before its read ends', async () => {
    const never = new Promise<GpuVramCardUsage[]>(() => undefined);
    const { store, electron } = setup({ chatRunCommand: TUNED, autoTuned });
    electron.llamaServerVramUsage.mockReturnValue(never);
    store.onManagedInventoryPick(`gguf:${GEMMA}`);
    const managed = store.selectedLlamaCppManaged();
    expect(flagValue(managed.chatRunCommand, '-m')).toBe(GEMMA);
    expectPlanGone(managed, store);
  });

  it('stays on a re-pick of the same file', async () => {
    const never = new Promise<GpuVramCardUsage[]>(() => undefined);
    const { store, electron } = setup({ chatRunCommand: TUNED, autoTuned });
    electron.llamaServerVramUsage.mockReturnValue(never);
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    expect(flagValue(store.selectedLlamaCppManaged().chatRunCommand, '-ctk')).toBe('q8_0');
  });

  it('comes out when the next model has an unreadable header', async () => {
    const { store } = setup({ chatRunCommand: TUNED, autoTuned }, { profiles: {} });
    store.onManagedInventoryPick(`gguf:${GEMMA}`);
    const managed = await settled(store);
    expect(flagValue(managed.chatRunCommand, '-m')).toBe(GEMMA);
    expectPlanGone(managed, store);
  });

  it('stays on a re-pick of the same model when its header cannot be read', async () => {
    const { store } = setup({ chatRunCommand: TUNED, autoTuned }, { profiles: {} });
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const managed = await settled(store);
    expect(flagValue(managed.chatRunCommand, '-c')).toBe('45056');
    expect(flagValue(managed.chatRunCommand, '-ctk')).toBe('q8_0');
    expect(flagValue(managed.chatRunCommand, '-ctv')).toBe('q8_0');
    expect(managed.autoTuned).toEqual(autoTuned);
    expect(store.selectedModel()?.contextWindowTokens).toBe(45056);
  });

  it('leaves hand-written flags in those cases', async () => {
    const hand = `llama-server --port {{PORT}} -m ${MIMO} -c 50000 -ctk f16 -ctv f16`;
    const { store } = setup({ chatRunCommand: hand, autoTuned }, { profiles: {} });
    store.onManagedInventoryPick('hf:org/model:Q4_0');
    const { chatRunCommand } = await settled(store);
    expect(flagValue(chatRunCommand, '-c')).toBe('50000');
    expect(flagValue(chatRunCommand, '-ctk')).toBe('f16');
    expect(flagValue(chatRunCommand, '-ctv')).toBe('f16');
  });

  it('loses its q8 when the user set -c and the next model cannot load it', async () => {
    const noQ8: GgufProfile = { ...PROFILE_BASE, cacheLengths: [80] };
    const { store } = setup({ chatRunCommand: TUNED, autoTuned }, { profiles: { [GEMMA]: noQ8 } });
    store.setManagedChatRunCommand(TUNED.replace('-c 45056', '-c 64000'));
    store.onManagedInventoryPick(`gguf:${GEMMA}`);
    const { chatRunCommand } = await settled(store);
    expect(flagValue(chatRunCommand, '-c')).toBe('64000');
    expect(chatRunCommand).not.toContain('q8_0');
  });
});

describe('a projector', () => {
  const PROJECTOR = '/models/mimo/mmproj-MiMo-V2.6-Distill-Qwen-9B-BF16.gguf';
  const FRESH = 'llama-server --host 127.0.0.1 --port {{PORT}} --jinja --no-webui -np 1 -hf org/model:Q4_0';
  const CARD: CudaGpuDevice[] = [{ cudaIndex: 0, model: 'NVIDIA GeForce RTX 5070', memoryTotalMb: 12288 }];
  const QUIET: GpuVramCardUsage[] = [{ cudaIndex: 0, dedicatedMb: 0, otherMb: 0 }];

  it('picked with the model gets room in the plan, from its size on disk', async () => {
    const plain = setup({ chatRunCommand: FRESH }, { gpus: CARD, usage: QUIET });
    plain.store.onManagedInventoryPick(`gguf:${MIMO}`);
    const without = (await settled(plain.store)).autoTuned?.c ?? 0;
    expect(plain.electron.llamaServerGgufSize).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    const { store, electron } = setup({ chatRunCommand: FRESH }, { gpus: CARD, usage: QUIET });
    store.modelManagerCustomModels.set([loose(MIMO), loose(PROJECTOR)]);
    electron.llamaServerGgufSize.mockResolvedValue(1024 ** 3);
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const { chatRunCommand, autoTuned } = await settled(store);
    expect(flagValue(chatRunCommand, '--mmproj')).toBe(PROJECTOR);
    expect(electron.llamaServerGgufSize).toHaveBeenCalledWith({ path: PROJECTOR });
    expect(autoTuned?.c).toBeLessThan(without);
    expect(flagValue(chatRunCommand, '-c')).toBe(String(autoTuned?.c));
  });

  it('whose size cannot be read still leaves a plan', async () => {
    const { store } = setup({ chatRunCommand: FRESH }, { gpus: CARD, usage: QUIET });
    store.modelManagerCustomModels.set([loose(MIMO), loose(PROJECTOR)]);
    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const { autoTuned } = await settled(store);
    expect(autoTuned?.c).toBeGreaterThan(0);
  });
});

describe('Apply', () => {
  const FRESH = 'llama-server --host 127.0.0.1 --port {{PORT}} --jinja --no-webui -np 1 -hf org/model:Q4_0';

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  }

  function ready(usage?: Promise<GpuVramCardUsage[]>) {
    const { store, electron } = setup({ chatRunCommand: FRESH });
    (store as unknown as { configSnapshot: unknown }).configSnapshot = {};
    if (usage) {
      electron.llamaServerVramUsage.mockReturnValue(usage);
    }
    return { store, electron };
  }

  const savedCommand = (config: AppConfig): string | undefined =>
    config.llmProviders[0]?.models[0]?.llamaCppManaged?.chatRunCommand;

  it('is clean afterwards when nothing changed during the save', async () => {
    const { store } = ready();
    store.setManagedChatRunCommand(`${FRESH} -c 4096`);
    await store.applySettings();
    expect(store.settingsDirty()).toBe(false);
  });

  it('stays dirty when a plan lands during the save, and the next one saves it', async () => {
    const vram = deferred<GpuVramCardUsage[]>();
    const { store, electron } = ready(vram.promise);
    const save = deferred<unknown>();
    electron.saveConfig.mockReturnValueOnce(save.promise);

    store.onManagedInventoryPick(`gguf:${MIMO}`);
    const applying = store.applySettings();
    await vi.waitFor(() => expect(electron.saveConfig).toHaveBeenCalledTimes(1));
    expect(savedCommand(electron.saveConfig.mock.calls[0]?.[0] as AppConfig)).not.toContain('-ctk');

    vram.resolve([{ cudaIndex: 0, dedicatedMb: 0, otherMb: 0 }]);
    await settled(store);
    expect(store.selectedLlamaCppManaged().chatRunCommand).toContain('-ctk q8_0');
    save.resolve(SAVED);
    await applying;
    expect(store.settingsDirty()).toBe(true);

    await store.applySettings();
    expect(savedCommand(electron.saveConfig.mock.calls[1]?.[0] as AppConfig)).toContain('-ctk q8_0');
    expect(store.settingsDirty()).toBe(false);
  });

  it('stays dirty after an edit made during the save', async () => {
    const { store, electron } = ready();
    const save = deferred<unknown>();
    electron.saveConfig.mockReturnValueOnce(save.promise);
    store.setManagedChatRunCommand(`${FRESH} -c 4096`);
    const applying = store.applySettings();
    await vi.waitFor(() => expect(electron.saveConfig).toHaveBeenCalledTimes(1));
    store.setManagedChatRunCommand(`${FRESH} -c 8192`);
    save.resolve(SAVED);
    await applying;
    expect(store.settingsDirty()).toBe(true);
  });
});

describe('the header of the selected model', () => {
  it('sizes the recommendation once it has been read', async () => {
    const { store } = setup({ chatRunCommand: `llama-server --port {{PORT}} -m ${MIMO} -c 131072 -ctk q8_0 -ctv q8_0` });
    store.modelManagerCustomModels.set([{ ...loose(MIMO), sizeBytes: 60 * 1024 ** 3 }]);
    expect(store.managedGpuAdvice()?.reason).not.toMatch(/fits on/);
    await store.loadManagedGgufProfile(MIMO);
    expect(store.managedGgufProfile()).toEqual(PROFILE_BASE);
    expect(store.managedGpuAdvice()?.reason).toMatch(/fits on/);
  });

  it('keeps an earlier read when a later one fails', async () => {
    const { store, electron } = setup({ chatRunCommand: `llama-server --port {{PORT}} -m ${MIMO}` });
    await store.loadManagedGgufProfile(MIMO);
    electron.llamaServerGgufProfile.mockResolvedValue(null);
    await store.loadManagedGgufProfile(MIMO);
    expect(store.managedGgufProfile()).toEqual(PROFILE_BASE);
  });

  it('finds the head the model can run on', async () => {
    const { store } = setup({ chatRunCommand: `llama-server --port {{PORT}} -m ${GEMMA}` });
    expect(store.managedMtpHead()).toBeNull();
    await store.loadManagedGgufProfile(GEMMA);
    expect(store.managedMtpHead()).toBeNull();
    await store.loadManagedGgufProfile(store.managedMtpCompanionPath());
    expect(store.managedMtpHead()).toEqual({ companionPath: GEMMA_HEAD });
  });
});

describe('choosing a card', () => {
  it('pins the card asked for, with no --main-gpu', () => {
    const { store } = setup({ chatRunCommand: `llama-server --port {{PORT}} -m ${MIMO} -dev CUDA0 --main-gpu 0` });
    store.onManagedGpuOffloadChange('single', 1);
    const { chatRunCommand } = store.selectedLlamaCppManaged();
    expect(flagValue(chatRunCommand, '-dev')).toBe('CUDA1');
    expect(chatRunCommand).not.toContain('--main-gpu');
  });
});
