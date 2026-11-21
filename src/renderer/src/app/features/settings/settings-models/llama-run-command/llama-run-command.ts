import { Component, DestroyRef, ViewEncapsulation, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  analyzeLlamaRunCommand,
  appendLlamaFlag,
  CTX_FLAG_NAMES,
  detectShellQuotingPlatform,
  diffLlamaCommands,
  estimateManagedLlamaVram,
  HF_FLAG_NAMES,
  llamaCommandUsesDraftMtp,
  managedLlamaDeviceList,
  MANAGED_LLAMA_CACHE_TYPES,
  MANAGED_LLAMA_FLASH_ATTN_MODES,
  type ManagedGpuOffloadMode,
  MODEL_FLAG_NAMES,
  normalizeLlamaCommandInput,
  overcommittedCards,
  parseManagedLlamaGpuOffload,
  preferredLlamaFlagName,
  removeLlamaEntry,
  setLlamaEntryValue,
  shortCudaGpuName,
  syncMtpDraftInManagedChatCommand,
  syncTensorSplitSliderInManagedChatCommand,
  tensorSplitForGpus,
  tensorSplitSliderForCommand,
  type CudaGpuDevice,
  type GpuVramCardEstimate,
  type GpuVramLevel,
  type LlamaCommandEntry,
  type LlamaFlagCatalog,
  type LlamaFlagSpec,
  type LlamaFlagStatus,
  type ManagedMtpHead,
  type TensorSplitSlider,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../../core/electron.service';
import { PillSelectComponent } from '../../../../shared/pill-select/pill-select';
import { SettingsStore } from '../../settings/settings-store';

type RunCommandView = 'flags' | 'raw';

interface GpuPlacement {
  id: string;
  mode: ManagedGpuOffloadMode;
  /** The card for a one-card placement. */
  gpu?: CudaGpuDevice;
  label: string;
}

/** One card's part of the model strip. `share` and `overPct` are percentages. */
interface ModelStripSegment {
  key: string;
  slot: number;
  name: string;
  /** GB on the card, or its share of the split when the model size isn't known. */
  size: string;
  share: number;
  /** How much of this segment doesn't fit on the card and runs from system RAM. */
  overPct: number;
}

interface ModelStrip {
  /** `null` when the model size isn't known and the strip only shows the split. */
  totalMb: number | null;
  segments: ModelStripSegment[];
}

interface GpuGauge {
  key: string;
  slot: number;
  name: string;
  level: GpuVramLevel | 'idle';
  otherPct: number;
  modelPct: number;
  freeText: string;
  detail: string;
}

/** Each card's colour in the strip and its gauge; CSS has one per slot. */
const GPU_COLOR_SLOTS = 4;
/** Width of the strip's drag handle; the range input is offset by half of it. */
const SPLIT_HANDLE_PX = 14;

const STATUS_LABELS: Readonly<Record<LlamaFlagStatus, string>> = {
  used: 'Used',
  overridden: 'Overridden',
  request: 'Per request',
  'no-effect': 'No effect',
  rewritten: 'Changed at start',
  managed: 'Set by Clara',
  invalid: 'Invalid',
  unknown: 'Not recognized',
};

/** Add-flag results shown at once; the query narrows the full ``--help`` list from there. */
const MAX_SUGGESTIONS = 8;

/** Flags most sources tune, offered in one click when the command doesn't set them yet. */
const COMMON_FLAGS: readonly {
  name: string;
  aliases: readonly string[];
  valueHint: string | null;
  choices?: readonly string[];
  value?: string;
}[] = [
  { name: '-c', aliases: ['--ctx-size'], valueHint: 'N (0 = model max)' },
  { name: '-ngl', aliases: ['--gpu-layers', '--n-gpu-layers'], valueHint: 'N, auto or all', value: 'auto' },
  { name: '-fa', aliases: ['--flash-attn'], valueHint: 'on, off or auto', choices: MANAGED_LLAMA_FLASH_ATTN_MODES },
  { name: '-ctk', aliases: ['--cache-type-k'], valueHint: 'TYPE', choices: MANAGED_LLAMA_CACHE_TYPES },
  { name: '-ctv', aliases: ['--cache-type-v'], valueHint: 'TYPE', choices: MANAGED_LLAMA_CACHE_TYPES },
  { name: '-b', aliases: ['--batch-size'], valueHint: 'N' },
  { name: '-ub', aliases: ['--ubatch-size'], valueHint: 'N' },
  { name: '--chat-template-file', aliases: [], valueHint: 'JINJA_TEMPLATE_FILE' },
  { name: '--no-mmproj', aliases: [], valueHint: null },
  { name: '--spec-type', aliases: [], valueHint: 'TYPE' },
];

/** The Local model picker owns these, so their rows only show what it set. */
const LOCKED_FLAG_NAMES = [...MODEL_FLAG_NAMES, ...HF_FLAG_NAMES];
const NO_MMPROJ_FLAG = '--no-mmproj';
const CHAT_TEMPLATE_FILE_FLAG = '--chat-template-file';
const FILE_VALUE_HINT_RE = /FILE|FNAME|PATH/;
/** Keeps the live VRAM warning current while a server runs. Each sample starts a short PowerShell. */
const VRAM_REFRESH_MS = 30_000;

/**
 * Editor for the managed ``llama-server`` chat command. The saved command stays the single source
 * of truth: every row edits its span of that string, so hand edits, the Settings controls and this
 * list always agree.
 */
@Component({
  selector: 'app-llama-run-command',
  imports: [FormsModule, LucideAngularModule, PillSelectComponent],
  templateUrl: './llama-run-command.html',
  styleUrl: './llama-run-command.css',
  encapsulation: ViewEncapsulation.None,
})
export class LlamaRunCommandComponent {
  protected readonly s = inject(SettingsStore);
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platform = detectShellQuotingPlatform();
  private rawEdited = false;

  protected readonly view = signal<RunCommandView>('flags');
  protected readonly catalog = signal<LlamaFlagCatalog | null>(null);
  protected readonly catalogError = signal('');
  /** ``n_ctx`` each running server reported, which ``--fit`` or ``-c 0`` can make differ from ``-c``. */
  private readonly liveNctxByModel = toSignal(this.electron.llamaServerNctx$, {
    initialValue: {} as Readonly<Record<string, number>>,
  });
  /** The command the running server was spawned with. */
  private readonly launchedCommand = signal<string | null>(null);
  /** This machine's RAM: a small one gets a prompt cache limit at start. */
  private readonly totalRamBytes = signal<number | null>(null);

  protected readonly command = computed(() => this.s.selectedLlamaCppManaged().chatRunCommand);

  /** Settings the backend sends on every request, which beat the server's startup defaults. */
  private readonly requestOverrides = computed(() => {
    const connection = this.s.selectedResolved();
    if (!connection) {
      return [];
    }
    const overrides: { names: string[]; label: string }[] = [{ names: ['--temp', '--temperature'], label: 'Temperature' }];
    if (connection.topP != null) {
      overrides.push({ names: ['--top-p'], label: 'top_p' });
    }
    if (connection.topK != null) {
      overrides.push({ names: ['--top-k'], label: 'top_k' });
    }
    if (connection.minP != null) {
      overrides.push({ names: ['--min-p'], label: 'min_p' });
    }
    if (connection.presencePenalty != null) {
      overrides.push({ names: ['--presence-penalty'], label: 'Presence' });
    }
    if (connection.repeatPenalty != null) {
      overrides.push({ names: ['--repeat-penalty'], label: 'Repeat' });
    }
    // Max output 0 too: local agent steps then send the default per-step limit.
    overrides.push({ names: ['--predict', '--n-predict', '-n'], label: 'Max output' });
    return overrides;
  });

  protected readonly analysis = computed(() =>
    analyzeLlamaRunCommand(this.command(), {
      catalog: this.catalog(),
      requestOverrides: this.requestOverrides(),
      optimizationPreset: this.s.selectedResolved()?.optimizationPreset,
      platform: this.platform,
      profile: this.s.managedGgufProfile(),
      totalRamBytes: this.totalRamBytes(),
    }),
  );

  protected readonly summary = computed(() => {
    const { entries, addedAtStart } = this.analysis();
    const notUsed = entries.filter((e) => e.status !== 'used' && e.status !== 'managed').length;
    const parts = [`${entries.length} ${entries.length === 1 ? 'flag' : 'flags'}`];
    if (notUsed) {
      parts.push(`${notUsed} to review`);
    }
    if (addedAtStart.length) {
      parts.push(`${addedAtStart.length} added at start`);
    }
    return parts.join(' · ');
  });

  /** What a restart would change. Empty when nothing is running or the server is up to date. */
  protected readonly pendingChanges = computed(() => {
    const launched = this.launchedCommand();
    return launched ? diffLlamaCommands(launched, this.analysis().startCommand, this.catalog()) : [];
  });

  /** Common flags the command doesn't set yet. */
  protected readonly commonFlags = computed(() => {
    const used = new Set(this.analysis().entries.map((e) => e.name));
    return COMMON_FLAGS.filter((flag) => !used.has(flag.name) && !flag.aliases.some((alias) => used.has(alias)));
  });

  protected readonly placementOptions = computed((): GpuPlacement[] => {
    const gpus = this.s.cudaGpus();
    const options: GpuPlacement[] = gpus.map((gpu) => ({
      id: `single:${gpu.cudaIndex}`,
      mode: 'single',
      gpu,
      label: `${this.cardName(gpu)} only`,
    }));
    if (gpus.length >= 2) {
      const label = gpus.length === 2 ? `Split across ${gpus.map((g) => this.cardName(g)).join(' + ')}` : `Split across ${gpus.length} GPUs`;
      options.push({ id: 'split', mode: 'split', label });
    }
    options.push({ id: 'auto', mode: 'auto', label: 'All GPUs, llama-server decides' });
    return options.map((p) => (this.isRecommendedPlacement(p) ? { ...p, label: `${p.label} (recommended)` } : p));
  });

  /** Empty for a `-dev` list none of the options describe, so the picker shows its placeholder. */
  protected readonly activePlacementId = computed(() => {
    const command = this.command();
    const { mode, cudaIndexes } = parseManagedLlamaGpuOffload(command);
    // `none`, another backend's device or a card listed twice: not a list the options write.
    const listed = (managedLlamaDeviceList(command) ?? '').split(',').filter((device) => device.trim());
    if (listed.length !== cudaIndexes.length) {
      return '';
    }
    if (mode === 'split') {
      // The split option is every card: a list that leaves one out, or names one that isn't here, is custom.
      const gpus = this.s.cudaGpus();
      return cudaIndexes.length === gpus.length && gpus.every((g) => cudaIndexes.includes(g.cudaIndex)) ? 'split' : '';
    }
    const id = mode === 'single' ? `single:${cudaIndexes[0]}` : mode;
    return this.placementOptions().some((p) => p.id === id) ? id : '';
  });

  /** Shown while a split is active across two cards. */
  protected readonly tensorSplit = computed(() => tensorSplitSliderForCommand(this.command(), this.s.cudaGpus()));

  /** The split differs from the VRAM ratio a fresh split across every card would write. */
  protected readonly splitResettable = computed(() => {
    const { mode, cudaIndexes, tensorSplit } = parseManagedLlamaGpuOffload(this.command());
    const ordered = [...this.s.cudaGpus()].sort((a, b) => a.cudaIndex - b.cudaIndex);
    return (
      mode === 'split' &&
      cudaIndexes.join(',') === ordered.map((g) => g.cudaIndex).join(',') &&
      tensorSplit !== tensorSplitForGpus(ordered)
    );
  });

  /** The flags the placement writes, as the command has them now. Empty when it sets none. */
  protected readonly gpuFlags = computed(() => {
    const command = this.command();
    const { cudaIndexes, tensorSplit, mainGpu } = parseManagedLlamaGpuOffload(command);
    const device = managedLlamaDeviceList(command);
    const parts: string[] = [];
    // As written: `-dev none` or another backend's device is a GPU flag too.
    if (device) {
      parts.push(`-dev ${device}`);
    }
    // With no `-dev` it applies across every card. Beside one pinned card there is nothing to split.
    if (tensorSplit !== null && cudaIndexes.length !== 1) {
      parts.push(`--tensor-split ${tensorSplit}`);
    }
    if (mainGpu !== null) {
      parts.push(`--main-gpu ${mainGpu}`);
    }
    return parts.join('  ');
  });

  /** What this command would put on each card, for the settings as edited. */
  protected readonly vramEstimate = computed(() =>
    estimateManagedLlamaVram(
      this.command(),
      this.s.cudaGpus(),
      this.s.managedGgufSizeBytes(),
      this.s.managedVramUsage(),
      this.s.managedGgufProfile(),
      this.s.managedDraftModelBytes(),
    ),
  );
  /** The worst card, so a tight one never hides one that is over. */
  protected readonly vramProblem = computed(() => {
    const cards = this.vramEstimate();
    return cards?.find((c) => c.level === 'over') ?? cards?.find((c) => c.level === 'tight') ?? null;
  });
  /**
   * The model laid out across the cards it runs on, sized from the estimate. Without one, a split
   * still shows as shares so it can be dragged.
   */
  protected readonly modelStrip = computed((): ModelStrip | null => {
    const cards = this.vramEstimate();
    const totalMb = cards?.reduce((sum, c) => sum + c.modelMb, 0) ?? 0;
    if (cards?.length && totalMb > 0) {
      return {
        totalMb,
        segments: cards.map((c) => {
          const overMb = Math.max(0, c.totalMb - c.gpu.memoryTotalMb);
          return {
            key: String(c.gpu.cudaIndex),
            slot: this.slot(c.gpu),
            name: this.cardName(c.gpu),
            size: `${this.gb(c.modelMb)} GB`,
            share: (c.modelMb / totalMb) * 100,
            overPct: c.modelMb > 0 ? Math.min(100, (overMb / c.modelMb) * 100) : 0,
          };
        }),
      };
    }
    const split = this.tensorSplit();
    if (!split) {
      return null;
    }
    const firstShare = (split.value / split.total) * 100;
    // Rounded once, so the two labels always add up to 100%.
    const firstPct = Math.round(firstShare);
    const segment = (gpu: CudaGpuDevice, share: number, pct: number): ModelStripSegment => ({
      key: String(gpu.cudaIndex),
      slot: this.slot(gpu),
      name: this.cardName(gpu),
      size: `${pct}%`,
      share,
      overPct: 0,
    });
    return {
      totalMb: null,
      segments: [segment(split.first, firstShare, firstPct), segment(split.second, 100 - firstShare, 100 - firstPct)],
    };
  });

  /** Every card's VRAM with this command, including cards it leaves unused. */
  protected readonly gpuGauges = computed((): GpuGauge[] | null => {
    const cards = this.vramEstimate();
    if (!cards) {
      return null;
    }
    const usage = this.s.managedVramUsage();
    return this.s.cudaGpus().map((gpu): GpuGauge => {
      const capacityMb = gpu.memoryTotalMb;
      const pct = (mb: number): number => Math.max(0, Math.min(100, (mb / capacityMb) * 100));
      const base = { key: String(gpu.cudaIndex), slot: this.slot(gpu), name: this.cardName(gpu) };
      const card = cards.find((c) => c.gpu.cudaIndex === gpu.cudaIndex);
      if (!card) {
        const otherMb = usage.find((u) => u.cudaIndex === gpu.cudaIndex)?.otherMb ?? 0;
        return {
          ...base,
          level: 'idle',
          otherPct: pct(otherMb),
          modelPct: 0,
          freeText: 'Not used',
          detail: `${this.gb(Math.max(0, capacityMb - otherMb))} of ${this.gb(capacityMb)} GB free`,
        };
      }
      const freeMb = capacityMb - card.totalMb;
      const otherPct = pct(card.otherMb);
      // Under 0.1 GB would read as "0.0 GB".
      const others = card.otherMb >= 0.05 * 1024 ? ` · ${this.gb(card.otherMb)} GB desktop and apps` : '';
      return {
        ...base,
        level: card.level,
        otherPct,
        modelPct: Math.min(100 - otherPct, pct(card.modelMb)),
        freeText: freeMb >= 0 ? `${this.gb(freeMb)} GB free` : `${this.gb(-freeMb)} GB over`,
        detail: `About ${this.gb(card.totalMb)} of ${this.gb(capacityMb)} GB${others}`,
      };
    });
  });

  /** Cards past their physical memory right now, whatever the settings say. */
  protected readonly vramOvercommitted = computed(() => overcommittedCards(this.s.cudaGpus(), this.s.managedVramUsage()));

  /**
   * An MTP head this command could use. It's only offered: nothing turns it on by itself. Not across
   * cards, where the speed-up hasn't been measured.
   */
  protected readonly mtpOffer = computed((): ManagedMtpHead | null => {
    const head = this.s.managedMtpHead();
    const command = this.command();
    if (!head || llamaCommandUsesDraftMtp(command)) {
      return null;
    }
    const { mode } = parseManagedLlamaGpuOffload(command);
    return mode === 'split' || (mode === 'auto' && this.s.cudaGpus().length > 1) ? null : head;
  });

  protected readonly flagQuery = signal('');
  /** A chosen flag waiting for its value. */
  protected readonly draftSpec = signal<LlamaFlagSpec | null>(null);
  protected readonly draftName = signal('');
  protected readonly draftValue = signal('');

  protected readonly suggestions = computed(() => {
    const query = this.flagQuery().trim().toLowerCase();
    const flags = this.catalog()?.flags ?? [];
    if (!query) {
      return [];
    }
    const used = new Set(this.analysis().entries.map((e) => e.name));
    const available = flags.filter((spec) => !spec.names.some((name) => used.has(name)));
    const byName = available.filter((spec) => spec.names.some((name) => name.toLowerCase().includes(query)));
    const byText = available.filter(
      (spec) => !byName.includes(spec) && spec.description.toLowerCase().includes(query),
    );
    return [...byName, ...byText].slice(0, MAX_SUGGESTIONS);
  });

  constructor() {
    void this.loadCatalog();
    void this.electron.llamaServerTotalRam().then((bytes) => this.totalRamBytes.set(bytes));
    effect(() => {
      const id = this.s.selectedModel()?.id;
      void this.refreshLaunched(id);
    });
    effect(() => {
      void this.refreshGgufSize(this.s.managedGgufPath());
    });
    for (const path of [this.s.managedGgufPath, this.s.managedMtpCompanionPath, this.s.managedDraftModelPath]) {
      effect(() => {
        void this.s.loadManagedGgufProfile(path());
      });
    }
    void this.refreshVramUsage();
    this.electron.llamaServerLifecycle$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      void this.loadCatalog();
      void this.refreshLaunched(this.s.selectedModel()?.id);
      void this.refreshVramUsage();
    });
    const timer = setInterval(() => {
      // An overcommit alert says "right now", so it has to keep checking until it clears.
      if (this.launchedCommand() || this.vramOvercommitted().length) {
        void this.refreshVramUsage();
      }
    }, VRAM_REFRESH_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.commitRawEdit();
    });
  }

  private async refreshVramUsage(): Promise<void> {
    this.s.managedVramUsage.set(await this.electron.llamaServerVramUsage());
  }

  private async refreshGgufSize(path: string | null): Promise<void> {
    if (!path) {
      return;
    }
    const bytes = await this.electron.llamaServerGgufSize({ path });
    if (bytes !== null) {
      this.s.managedGgufFileSize.set({ path, bytes });
    }
  }

  private async loadCatalog(): Promise<void> {
    const res = await this.electron.llamaServerFlagCatalog();
    if (res.ok) {
      this.catalog.set(res.catalog);
      this.catalogError.set('');
    } else {
      this.catalogError.set(res.error);
    }
  }

  private async refreshLaunched(modelId: string | undefined): Promise<void> {
    if (!modelId) {
      this.launchedCommand.set(null);
      return;
    }
    const res = await this.electron.llamaServerLaunchedCommand({ modelId });
    if (this.s.selectedModel()?.id === modelId) {
      this.launchedCommand.set(res.ok ? res.command : null);
    }
  }

  protected statusLabel(status: LlamaFlagStatus): string {
    return STATUS_LABELS[status];
  }

  /** Model rows are read-only unless something is wrong with them. */
  protected isLocked(entry: LlamaCommandEntry): boolean {
    return entry.status === 'used' && LOCKED_FLAG_NAMES.includes(entry.name);
  }

  protected entryNote(entry: LlamaCommandEntry): string {
    if (this.isLocked(entry)) {
      return 'Set by Local model above.';
    }
    if (entry.status === 'used' && CTX_FLAG_NAMES.includes(entry.name)) {
      const modelId = this.s.selectedModel()?.id;
      const live = modelId ? this.liveNctxByModel()[modelId] : undefined;
      if (live && String(live) !== entry.value) {
        return `The running server loaded ${live} tokens.`;
      }
    }
    return entry.note;
  }

  protected takesFilePath(hint: string | null | undefined): boolean {
    return !!hint && FILE_VALUE_HINT_RE.test(hint);
  }

  private async browseForFile(flag: string): Promise<string | null> {
    const allFiles = { name: 'All files', extensions: ['*'] };
    return this.electron.openFileDialog({
      filters:
        flag === CHAT_TEMPLATE_FILE_FLAG
          ? [{ name: 'Chat templates', extensions: ['jinja', 'json'] }, allFiles]
          : [allFiles],
    });
  }

  protected async browseEntry(entry: LlamaCommandEntry): Promise<void> {
    const picked = await this.browseForFile(entry.name);
    // The command can change behind the dialog, which would leave this entry's spans stale.
    const current = this.analysis().entries.find((e) => e.id === entry.id);
    if (picked && current) {
      this.setEntryValue(current, picked);
    }
  }

  protected async browseDraft(): Promise<void> {
    const picked = await this.browseForFile(this.draftName());
    if (picked) {
      this.draftValue.set(picked);
    }
  }

  protected gb(mb: number): string {
    return (mb / 1024).toFixed(1);
  }

  protected vramAdvice(card: GpuVramCardEstimate): string {
    const name = shortCudaGpuName(card.gpu.model);
    return card.level === 'over'
      ? `Too much for the ${name}. Windows will push things out of VRAM and every app can lag. Lower -c or give this card less of the split.`
      : `Tight on the ${name}. Opening another app could start pushing things out of VRAM and cause lag.`;
  }

  protected shortGpuName(gpu: CudaGpuDevice): string {
    return shortCudaGpuName(gpu.model);
  }

  /** The card's short name, with its CUDA index when another card has the same name. */
  protected cardName(gpu: CudaGpuDevice): string {
    const name = shortCudaGpuName(gpu.model);
    const twin = this.s.cudaGpus().some((g) => g.cudaIndex !== gpu.cudaIndex && shortCudaGpuName(g.model) === name);
    return twin ? `${name} (CUDA${gpu.cudaIndex})` : name;
  }

  private slot(gpu: CudaGpuDevice): number {
    return Math.max(0, this.s.cudaGpus().findIndex((g) => g.cudaIndex === gpu.cudaIndex)) % GPU_COLOR_SLOTS;
  }

  /**
   * The range input sits over the strip so its thumb lands on the boundary between the cards:
   * value v of total is at v / total of the strip's width, for every v from 1 to total - 1.
   */
  protected splitHandleLeft(split: TensorSplitSlider): string {
    return `calc(${100 / split.total}% - ${SPLIT_HANDLE_PX / 2}px)`;
  }

  protected splitHandleWidth(split: TensorSplitSlider): string {
    return `calc(${(100 * (split.total - 2)) / split.total}% + ${SPLIT_HANDLE_PX}px)`;
  }

  protected splitValueText(split: TensorSplitSlider): string {
    const [a, b] = this.modelStrip()?.segments ?? [];
    return a && b
      ? `${a.size} on ${a.name}, ${b.size} on ${b.name}`
      : `${split.value} on ${this.cardName(split.first)}, ${split.total - split.value} on ${this.cardName(split.second)}`;
  }

  protected onTensorSplitInput(raw: string, total: number): void {
    const first = Number.parseInt(raw, 10);
    if (!Number.isNaN(first)) {
      this.save(syncTensorSplitSliderInManagedChatCommand(this.command(), first, total, this.platform));
    }
  }

  protected resetSplit(): void {
    this.s.onManagedGpuOffloadChange('split');
  }

  protected choosePlacementId(id: string): void {
    const placement = this.placementOptions().find((p) => p.id === id);
    if (placement) {
      this.s.onManagedGpuOffloadChange(placement.mode, placement.gpu?.cudaIndex);
    }
  }

  private isRecommendedPlacement(placement: GpuPlacement): boolean {
    const advice = this.s.managedGpuAdvice();
    return (
      advice?.mode === placement.mode && (placement.mode !== 'single' || advice.primaryCudaIndex === placement.gpu?.cudaIndex)
    );
  }

  protected mtpOfferText(head: ManagedMtpHead): string {
    const where = head.companionPath ? `beside it (${head.companionPath.split(/[/\\]/).pop()})` : 'inside it';
    return `This model has an MTP head ${where}. Speculative decoding can speed up generation for a little more VRAM.`;
  }

  protected addMtpFlags(head: ManagedMtpHead): void {
    this.save(syncMtpDraftInManagedChatCommand(this.command(), head, this.platform));
  }

  protected entryTitle(entry: LlamaCommandEntry): string {
    return entry.spec?.description ?? '';
  }

  protected choiceOptions(entry: LlamaCommandEntry): { id: string; label: string }[] {
    return this.withCurrent(entry.spec?.choices ?? [], entry.value ?? '');
  }

  protected draftOptions(spec: LlamaFlagSpec): { id: string; label: string }[] {
    return this.withCurrent(spec.choices ?? [], this.draftValue());
  }

  /** A value the help text doesn't enumerate (``--spec-type a,b``) still has to show as selected. */
  private withCurrent(choices: readonly string[], current: string): { id: string; label: string }[] {
    const rows = choices.map((choice) => ({ id: choice, label: choice }));
    return current && !choices.includes(current) ? [{ id: current, label: current }, ...rows] : rows;
  }

  private save(command: string): void {
    this.s.setManagedChatRunCommand(command);
  }

  /**
   * Keystrokes save the command only: a half-typed ``-c`` isn't a context size, so the profile
   * follows it once editing ends.
   */
  protected onRawChange(raw: string): void {
    this.rawEdited = true;
    this.s.patchLlamaCppManaged({ chatRunCommand: normalizeLlamaCommandInput(raw) });
  }

  protected commitRawEdit(): void {
    if (this.rawEdited) {
      this.rawEdited = false;
      this.save(this.command());
    }
  }

  protected setEntryValue(entry: LlamaCommandEntry, value: string): void {
    // A value flag left bare would take the next flag as its value, so clearing one removes it.
    if (entry.takesValue && !value.trim()) {
      this.removeEntry(entry);
    } else if (value !== entry.value) {
      this.save(setLlamaEntryValue(this.command(), entry, value.trim(), this.platform));
    }
  }

  /** ``--x=y`` to the ``--x y`` form llama-server accepts. */
  protected fixInline(entry: LlamaCommandEntry): void {
    this.save(setLlamaEntryValue(this.command(), entry, entry.value ?? '', this.platform));
  }

  protected removeEntry(entry: LlamaCommandEntry): void {
    if (entry.name === NO_MMPROJ_FLAG) {
      // Turning the projector back on also restores the one that belongs with this model.
      this.s.onManagedNoMmprojChange(false);
      return;
    }
    this.save(removeLlamaEntry(this.command(), entry));
  }

  protected addCommonFlag(flag: (typeof COMMON_FLAGS)[number]): void {
    const names = [flag.name, ...flag.aliases];
    const spec: LlamaFlagSpec = this.catalog()?.flags.find((f) => f.names.includes(flag.name)) ?? {
      names,
      valueHint: flag.valueHint,
      choices: flag.choices ? [...flag.choices] : null,
      description: '',
    };
    this.addFlag(spec, flag.name, flag.value);
  }

  protected suggestionName(spec: LlamaFlagSpec): string {
    const query = this.flagQuery().trim().toLowerCase();
    return spec.names.find((name) => query && name.toLowerCase().includes(query)) ?? preferredLlamaFlagName(spec);
  }

  protected pickSuggestion(spec: LlamaFlagSpec): void {
    this.addFlag(spec, this.suggestionName(spec));
  }

  private addFlag(spec: LlamaFlagSpec, name: string, value?: string): void {
    this.flagQuery.set('');
    if (name === NO_MMPROJ_FLAG) {
      // Also drops any --mmproj, which --no-mmproj would otherwise leave doing nothing.
      this.s.onManagedNoMmprojChange(true);
      return;
    }
    if (spec.valueHint === null) {
      this.save(appendLlamaFlag(this.command(), name, null, this.platform));
      return;
    }
    this.draftSpec.set(spec);
    this.draftName.set(name);
    this.draftValue.set(value ?? spec.choices?.[0] ?? '');
  }

  protected commitDraft(): void {
    const value = this.draftValue().trim();
    if (!value) {
      return;
    }
    this.save(appendLlamaFlag(this.command(), this.draftName(), value, this.platform));
    this.cancelDraft();
  }

  protected cancelDraft(): void {
    this.draftSpec.set(null);
    this.draftName.set('');
    this.draftValue.set('');
  }

  /** Enter takes the top match, or a typed ``--flag value`` as written. */
  protected onQueryEnter(event: Event): void {
    event.preventDefault();
    const top = this.suggestions()[0];
    const typed = this.flagQuery().trim();
    if (typed.startsWith('-') && /\s/.test(typed)) {
      this.save(`${this.command().trim()} ${typed}`);
      this.flagQuery.set('');
    } else if (top) {
      this.pickSuggestion(top);
    } else if (typed.startsWith('-')) {
      this.save(appendLlamaFlag(this.command(), typed, null, this.platform));
      this.flagQuery.set('');
    }
  }
}
