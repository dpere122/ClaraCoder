import { Component, DestroyRef, ViewEncapsulation, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  analyzeLlamaRunCommand,
  appendLlamaFlag,
  detectShellQuotingPlatform,
  diffLlamaCommands,
  estimateManagedLlamaVram,
  MANAGED_LLAMA_CACHE_TYPES,
  MANAGED_LLAMA_FLASH_ATTN_MODES,
  type ManagedGpuOffloadMode,
  normalizeLlamaCommandInput,
  overcommittedCards,
  preferredLlamaFlagName,
  removeLlamaEntry,
  setLlamaEntryValue,
  shortCudaGpuName,
  syncTensorSplitSliderInManagedChatCommand,
  tensorSplitSliderForCommand,
  type CudaGpuDevice,
  type GpuVramCardEstimate,
  type LlamaCommandEntry,
  type LlamaFlagCatalog,
  type LlamaFlagSpec,
  type LlamaFlagStatus,
} from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { ElectronService } from '../../../../core/electron.service';
import { PillSelectComponent } from '../../../../shared/pill-select/pill-select';
import { SettingsStore } from '../../settings/settings-store';

type RunCommandView = 'flags' | 'raw';

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
const MODEL_FLAG_NAMES = ['-m', '--model', '-hf', '-hfr', '--hf-repo'];
const CTX_FLAG_NAMES = ['-c', '--ctx-size'];
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

  protected readonly view = signal<RunCommandView>('flags');
  protected readonly catalog = signal<LlamaFlagCatalog | null>(null);
  protected readonly catalogError = signal('');
  /** ``n_ctx`` each running server reported, which ``--fit`` or ``-c 0`` can make differ from ``-c``. */
  private readonly liveNctxByModel = toSignal(this.electron.llamaServerNctx$, {
    initialValue: {} as Readonly<Record<string, number>>,
  });
  /** The command the running server was spawned with. */
  private readonly launchedCommand = signal<string | null>(null);

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
    if (connection.maxOutputTokens > 0) {
      overrides.push({ names: ['--predict', '--n-predict', '-n'], label: 'Max output' });
    }
    return overrides;
  });

  protected readonly analysis = computed(() =>
    analyzeLlamaRunCommand(this.command(), {
      catalog: this.catalog(),
      requestOverrides: this.requestOverrides(),
      optimizationPreset: this.s.selectedResolved()?.optimizationPreset,
      platform: this.platform,
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
    const used = new Set(this.analysis().entries.map((e) => e.flag));
    return COMMON_FLAGS.filter((flag) => !used.has(flag.name) && !flag.aliases.some((alias) => used.has(alias)));
  });

  protected readonly gpuPlacements: readonly { mode: ManagedGpuOffloadMode; label: string }[] = [
    { mode: 'single', label: 'Fastest card' },
    { mode: 'split', label: 'Split by VRAM' },
    { mode: 'auto', label: 'All GPUs' },
  ];

  /** Shown while Split by VRAM is active across two cards. */
  protected readonly tensorSplit = computed(() => tensorSplitSliderForCommand(this.command(), this.s.cudaGpus()));

  /** What this command would put on each card, for the settings as edited. */
  protected readonly vramEstimate = computed(() =>
    estimateManagedLlamaVram(this.command(), this.s.cudaGpus(), this.s.managedGgufSizeBytes(), this.s.managedVramUsage()),
  );
  protected readonly vramProblem = computed(() => this.vramEstimate()?.find((c) => c.level !== 'ok') ?? null);
  /** Cards past their physical memory right now, whatever the settings say. */
  protected readonly vramOvercommitted = computed(() => overcommittedCards(this.s.cudaGpus(), this.s.managedVramUsage()));

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
    const used = new Set(this.analysis().entries.map((e) => e.flag));
    const available = flags.filter((spec) => !spec.names.some((name) => used.has(name)));
    const byName = available.filter((spec) => spec.names.some((name) => name.toLowerCase().includes(query)));
    const byText = available.filter(
      (spec) => !byName.includes(spec) && spec.description.toLowerCase().includes(query),
    );
    return [...byName, ...byText].slice(0, MAX_SUGGESTIONS);
  });

  constructor() {
    void this.loadCatalog();
    effect(() => {
      const id = this.s.selectedModel()?.id;
      void this.refreshLaunched(id);
    });
    effect(() => {
      void this.refreshGgufSize(this.s.managedGgufPath());
    });
    void this.refreshVramUsage();
    this.electron.llamaServerLifecycle$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      void this.refreshLaunched(this.s.selectedModel()?.id);
      void this.refreshVramUsage();
    });
    const timer = setInterval(() => {
      if (this.launchedCommand()) {
        void this.refreshVramUsage();
      }
    }, VRAM_REFRESH_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
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
    this.launchedCommand.set(res.ok ? res.command : null);
  }

  protected statusLabel(status: LlamaFlagStatus): string {
    return STATUS_LABELS[status];
  }

  /** Model rows are read-only unless something is wrong with them. */
  protected isLocked(entry: LlamaCommandEntry): boolean {
    return entry.status === 'used' && MODEL_FLAG_NAMES.includes(entry.flag);
  }

  protected entryNote(entry: LlamaCommandEntry): string {
    if (this.isLocked(entry)) {
      return 'Set by Local model above.';
    }
    if (entry.status === 'used' && CTX_FLAG_NAMES.includes(entry.flag)) {
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
    const picked = await this.browseForFile(entry.flag);
    if (picked) {
      this.setEntryValue(entry, picked);
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

  protected vramLine(card: GpuVramCardEstimate): string {
    const name = shortCudaGpuName(card.gpu.model);
    const breakdown = card.otherMb > 0 ? ` (${this.gb(card.modelMb)} model + ${this.gb(card.otherMb)} desktop and apps)` : '';
    return `${name}: about ${this.gb(card.totalMb)} of ${this.gb(card.gpu.memoryTotalMb)} GB${breakdown}`;
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

  protected gpuName(gpu: CudaGpuDevice): string {
    return `CUDA${gpu.cudaIndex} · ${shortCudaGpuName(gpu.model)}`;
  }

  protected onTensorSplitInput(raw: string, total: number): void {
    const first = Number.parseInt(raw, 10);
    if (!Number.isNaN(first)) {
      this.save(syncTensorSplitSliderInManagedChatCommand(this.command(), first, total, this.platform));
    }
  }

  protected isRecommendedPlacement(mode: ManagedGpuOffloadMode): boolean {
    return this.s.managedGpuAdvice()?.mode === mode;
  }

  protected placementDetail(mode: ManagedGpuOffloadMode): string {
    if (mode === 'single') {
      const advice = this.s.managedGpuAdvice();
      return advice ? `CUDA${advice.primaryCudaIndex} · ${this.s.managedPrimaryGpuLabel()}` : '';
    }
    if (mode === 'split') {
      return this.s.managedGpuSplitRatioLabel();
    }
    return 'llama.cpp default. Can overflow into RAM on mixed cards.';
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

  protected onRawChange(raw: string): void {
    this.save(normalizeLlamaCommandInput(raw));
  }

  protected setEntryValue(entry: LlamaCommandEntry, value: string): void {
    if (value !== entry.value) {
      this.save(setLlamaEntryValue(this.command(), entry, value.trim(), this.platform));
    }
  }

  /** ``--x=y`` to the ``--x y`` form llama-server accepts. */
  protected fixInline(entry: LlamaCommandEntry): void {
    this.save(setLlamaEntryValue(this.command(), entry, entry.value ?? '', this.platform));
  }

  protected removeEntry(entry: LlamaCommandEntry): void {
    if (entry.flag === NO_MMPROJ_FLAG) {
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
      defaultValue: null,
      section: '',
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
