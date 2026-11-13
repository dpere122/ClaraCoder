import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  OnDestroy,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import { PillSelectComponent, type PillSelectOption } from '../../../shared/pill-select/pill-select';
import type {
  AppConfig,
  LlamaServerLifecycleEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStatusResult,
  LlmProviderConfig,
  ModelManagerFileEntry,
} from '@shared/index';
import {
  findLlmModelLocation,
  findManagedLocalLlamaLocation,
  isPinnedLlamaServerUrlProviderId,
  isPinnedLmStudioProviderId,
  isPinnedOpenRouterProviderId,
  isPinnedAnthropicProviderId,
  anthropicSourceLabel,
  isPinnedLlmSourceId,
  managedLlamaSourceDisplayName,
  openRouterSourceLabel,
} from '@shared/index';
import { filter, merge } from 'rxjs';
import { subagentSources } from '@shared/subagent-sources';
import { ElectronService } from '../../../core/electron.service';
import { SubagentSourceStatusService } from '../../../core/subagent-source-status.service';

type ManagedLlamaPhase = 'idle' | 'starting' | 'downloading' | 'running';

const INVENTORY_SPINNER_TYPE = 'ball-pulse-sync' as const;
const INVENTORY_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'var(--t-primary)',
  type: INVENTORY_SPINNER_TYPE,
};

/**
 * LLM source picker + managed ``llama-server`` Start/Stop controls, shown in
 * the status bar and the home Runtime panel. The Start/Stop button is enabled
 * only for a managed (non-URL-only) llamacpp source — i.e. the local llama
 * server — and disabled for everything else. An inline loading spinner shows
 * while the local model inventory (source labels) is being fetched.
 *
 * On the home page the dropdown lists every LLM source and picking one makes it
 * active at once, so a stopped local model can be picked and started there.
 *
 * In the workspace's status bar it swaps the main agent's model between sources
 * that would answer now (a running local server, or any other source that passes
 * main's connection check) and every local model the app can start; the active
 * one is always listed. Picking one only selects it; the button then reads
 * Switch, in red, and makes it active, or Start for a stopped local model, which
 * makes it active and starts its server.
 */
@Component({
  selector: 'app-managed-llama-controls',
  imports: [NgxSpinnerComponent, PillSelectComponent],
  templateUrl: './managed-llama-controls.html',
  styleUrl: './managed-llama-controls.css',
})
export class ManagedLlamaControlsComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly inj = inject(Injector);
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly sourceStatus = inject(SubagentSourceStatusService);

  /** Live app config from the shell; drives the active source and start/stop IPC calls. */
  readonly appConfig = input<AppConfig | null>(null);
  /** `status-bar`: compact single row for the app footer. */
  readonly layout = input<'default' | 'status-bar'>('default');

  protected readonly phase = signal<ManagedLlamaPhase>('idle');
  /** Why the last start failed, which is what the server said when it exited. */
  protected readonly startError = signal('');
  /** The user cancelled the start in flight, so its failure isn't news. */
  private cancelled = false;

  /** Monotonic id for the latest in-flight status probe; stale completions are ignored. */
  private probeRequestId = 0;

  /** Local model inventory (Model Manager custom dir listing), used to resolve source labels. */
  protected readonly inventory = signal<ModelManagerFileEntry[]>([]);
  /** True while the inventory fetch is in flight (drives the inline source-label spinner). */
  protected readonly inventoryLoading = signal(false);
  protected readonly inventorySpinnerName = `managed-llama-inventory-${Math.random().toString(36).slice(2, 10)}`;
  protected readonly inventorySpinnerType = INVENTORY_SPINNER_TYPE;

  /** Configured custom models dir (string). The inventory reloads only when this
   *  value changes — not on every appConfig reference change (e.g. conversation
   *  switches re-broadcast config and would otherwise re-trigger the spinner). */
  protected readonly customModelsDir = computed(() => this.appConfig()?.modelManager.customModelsDir?.trim() ?? '');

  /** Sources listed in the dropdown, pinned rows first (same order as Settings → Sources). */
  protected readonly sources = computed<LlmProviderConfig[]>(() => {
    const cfg = this.appConfig();
    if (!cfg) {
      return [];
    }
    const list = cfg.llmProviders;
    const pinLm = list.find((p) => isPinnedLmStudioProviderId(p.id));
    const pinUrl = list.find((p) => isPinnedLlamaServerUrlProviderId(p.id));
    const pinOpenRouter = list.find((p) => isPinnedOpenRouterProviderId(p.id));
    const pinAnthropic = list.find((p) => isPinnedAnthropicProviderId(p.id));
    const rest = list.filter((p) => !isPinnedLlmSourceId(p.id));
    const head: LlmProviderConfig[] = [];
    if (pinLm) {
      head.push(pinLm);
    }
    if (pinUrl) {
      head.push(pinUrl);
    }
    if (pinOpenRouter) {
      head.push(pinOpenRouter);
    }
    if (pinAnthropic) {
      head.push(pinAnthropic);
    }
    return [...head, ...rest.filter((p) => p.provider !== 'llamacpp'), ...rest.filter((p) => p.provider === 'llamacpp')];
  });

  protected readonly statusBar = computed(() => this.layout() === 'status-bar');
  /** Status bar: the source picked in the menu but not switched to yet (empty: the active one). */
  private readonly pendingProviderId = signal('');
  /** The sources as the connection checks know them. */
  private readonly switchableSources = computed(() =>
    subagentSources(this.sources(), (provider) => this.sourceLabel(provider)),
  );
  /** When the status bar last asked main which sources answer. */
  private lastProbeAt = 0;

  /**
   * Custom sources form their own menu section, set apart from the pinned rows. The status bar
   * lists what the main agent can be swapped to now, every local model the app can start, and the
   * active and the picked source.
   */
  protected readonly sourceOptions = computed(() => {
    const running = new Set(
      this.switchableSources()
        .filter((source) => source.launchable && this.sourceStatus.serverPhase(source) === 'running')
        .map((source) => source.id),
    );
    const options = this.sources().map((provider): PillSelectOption & { id: string } => ({
      id: provider.id,
      label: this.sourceLabel(provider),
      group: isPinnedLlmSourceId(provider.id) ? '' : 'Custom',
      ...(running.has(provider.id) ? { indicator: 'running' as const } : {}),
    }));
    if (!this.statusBar()) {
      return options;
    }
    const answering = new Set(
      this.switchableSources()
        .filter((source) => source.launchable || this.sourceStatus.available(source))
        .map((source) => source.id),
    );
    const shown = this.selectedProviderId();
    const active = this.activeProviderId();
    return options.filter((option) => option.id === active || option.id === shown || answering.has(option.id));
  });

  protected readonly show = computed(() => this.sources().length > 0);

  /** Id of the provider that owns the active model preset (dropdown selection). */
  protected readonly activeProviderId = computed(() => {
    const cfg = this.appConfig();
    const mid = cfg?.activeLlmModelId?.trim();
    if (!cfg || !mid) {
      return '';
    }
    return findLlmModelLocation(cfg.llmProviders, mid)?.provider.id ?? '';
  });

  /** What the dropdown shows: the status bar's pick while one waits to be switched to, else the active source. */
  protected readonly selectedProviderId = computed(() => this.pendingProviderId() || this.activeProviderId());

  /** Status bar: a source other than the active one is picked, so the button switches to it. */
  protected readonly switchPending = computed(() => {
    const pending = this.pendingProviderId();
    return this.statusBar() && pending !== '' && pending !== this.activeProviderId();
  });

  /** Status bar: the picked source is a local model whose server is off, so the button starts it. */
  protected readonly startPending = computed(() => {
    if (!this.switchPending()) {
      return false;
    }
    const pending = this.pendingProviderId();
    const source = this.switchableSources().find((s) => s.id === pending);
    return !!source?.launchable && this.sourceStatus.serverPhase(source) === 'off';
  });

  /** Active model location; null when the active source is not a managed local llama server. */
  private readonly activeLocation = computed(() => {
    const cfg = this.appConfig();
    return cfg ? findManagedLocalLlamaLocation(cfg) : null;
  });

  /** Whether the active source is a local llama server (Start/Stop eligible). */
  protected readonly isLocalLlama = computed(() => this.activeLocation() !== null);

  /** Active provider kind, used to hide the managed server button for hosted APIs. */
  private readonly activeProviderKind = computed(() => {
    const cfg = this.appConfig();
    const mid = cfg?.activeLlmModelId?.trim();
    if (!cfg || !mid) {
      return null;
    }
    return findLlmModelLocation(cfg.llmProviders, mid)?.provider.provider ?? null;
  });

  /** Start/Stop is the managed local llama-server. Hide it while a hosted API (OpenRouter, Claude) is the chat source. */
  protected readonly showManagedStart = computed(() => {
    const kind = this.activeProviderKind();
    return kind !== 'openrouter' && kind !== 'anthropic';
  });

  protected readonly modelId = computed(() => this.activeLocation()?.model.id ?? '');

  protected readonly chatRunCommand = computed(
    () => this.activeLocation()?.model.llamaCppManaged?.chatRunCommand ?? '',
  );

  protected readonly running = computed(() => this.phase() === 'running');
  protected readonly busy = computed(
    () => this.phase() === 'starting' || this.phase() === 'downloading',
  );

  protected readonly actionLabel = computed(() => {
    if (this.startPending()) {
      return 'Start';
    }
    if (this.switchPending()) {
      return 'Switch';
    }
    if (this.running()) {
      return 'Stop';
    }
    if (this.busy()) {
      return 'Cancel';
    }
    return 'Start';
  });

  constructor() {
    merge(this.electron.llamaServerLifecycle$, this.electron.llamaServerProcessExit$)
      .pipe(
        filter((e) => {
          const id = this.modelId();
          return !!id && e.modelId === id;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((e) => {
        if ((e as LlamaServerLifecycleEvent | LlamaServerProcessExitEvent) && 'phase' in e) {
          const ev = e as LlamaServerLifecycleEvent;
          if (ev.phase === 'starting') {
            this.phase.set('starting');
          } else if (ev.phase === 'downloading') {
            this.phase.set('downloading');
          } else if (ev.phase === 'running') {
            this.phase.set('running');
            this.startError.set('');
          } else if (ev.phase === 'stopped') {
            this.phase.set('idle');
          }
        } else {
          const ev = e as LlamaServerProcessExitEvent;
          if (ev.stream === 'chat' || this.phase() !== 'running') {
            this.phase.set('idle');
          }
        }
      });

    effect(() => {
      const cfg = this.appConfig();
      const loc = this.activeLocation();
      if (!cfg || !loc) {
        // Not a local llama server: keep the button idle/disabled.
        this.phase.set('idle');
        return;
      }
      void this.probeStatus(cfg);
    });

    // A failure is about one model's last start: drop it when another source becomes active,
    // including from outside this control (Settings), where nothing else would clear it.
    effect(() => {
      this.modelId();
      untracked(() => this.startError.set(''));
    });

    // A pick waits for Switch only while the active source stays what it was.
    effect(() => {
      this.activeProviderId();
      untracked(() => this.pendingProviderId.set(''));
    });

    // Ask main which sources answer, again on every config change (a source's URL or key may be what
    // changed), as the composer does for the active source.
    effect(() => {
      const key = this.switchableSources()
        .map((source) => `${source.id}:${source.connectionId}:${source.launchable}`)
        .join('|');
      if (key) {
        untracked(() => this.refreshSwitchable(true));
      }
    });

    // Keep the local model inventory in sync with the configured custom models dir
    // so source labels resolve the same file names as the Settings sources list.
    // Depends only on the dir string so conversation switches (which re-broadcast
    // an unchanged config) don't re-trigger the loading spinner.
    effect(() => {
      const dir = this.customModelsDir();
      if (!dir) {
        this.inventory.set([]);
        return;
      }
      void this.refreshInventory(dir);
    });

    // Show/hide the inline inventory spinner alongside the loading signal.
    effect(() => {
      const loading = this.inventoryLoading();
      untracked(() => this.scheduleSpinnerSync(loading));
    });
  }

  ngOnDestroy(): void {
    void this.ngxSpinner.hide(this.inventorySpinnerName);
  }

  private scheduleSpinnerSync(show: boolean): void {
    afterNextRender(
      () => {
        if (show) {
          void this.ngxSpinner.show(this.inventorySpinnerName, INVENTORY_SPINNER);
        } else {
          void this.ngxSpinner.hide(this.inventorySpinnerName);
        }
      },
      { injector: this.inj },
    );
  }

  /** Display name for a source option in the dropdown (model name for llama, OpenRouter and Claude sources, else stored name). */
  protected sourceLabel(provider: LlmProviderConfig): string {
    if (provider.provider === 'openrouter') {
      return openRouterSourceLabel(provider);
    }
    if (provider.provider === 'anthropic') {
      return anthropicSourceLabel(provider);
    }
    return managedLlamaSourceDisplayName(provider, this.inventory());
  }

  private async refreshInventory(customDir: string): Promise<void> {
    this.inventoryLoading.set(true);
    try {
      const res = await this.electron.modelManagerListCustomModels({ customDir });
      if (res.ok) {
        this.inventory.set(res.models);
      } else {
        this.inventory.set([]);
      }
    } finally {
      this.inventoryLoading.set(false);
    }
  }

  /**
   * Asks main which sources answer now: every source in the status bar, only the local servers'
   * state (for their running lights) on the home page. Runs when the list of sources changes and
   * when the user reaches for the menu, at most every few seconds.
   */
  protected refreshSwitchable(force = false): void {
    const cfg = this.appConfig();
    const now = Date.now();
    if (!cfg || (!force && now - this.lastProbeAt < 5000)) {
      return;
    }
    const sources = this.statusBar()
      ? this.switchableSources()
      : this.switchableSources().filter((source) => source.launchable);
    if (sources.length === 0) {
      return;
    }
    this.lastProbeAt = now;
    void this.sourceStatus.probe(cfg, sources);
  }

  /** The dropdown changed: the home page switches at once, the status bar waits for Switch. */
  protected async onSourceChange(providerId: string): Promise<void> {
    if (this.statusBar()) {
      this.startError.set('');
      this.pendingProviderId.set(providerId === this.activeProviderId() ? '' : providerId);
      return;
    }
    await this.activateSource(providerId);
  }

  /**
   * The button: Start while a stopped local model is picked (it becomes active and its server
   * starts), Switch while another source is picked, else Start, Cancel or Stop for the local server.
   */
  protected async onAction(): Promise<void> {
    if (this.startPending()) {
      const activated = await this.activateSource(this.pendingProviderId());
      if (activated) {
        await this.start(activated.modelId, activated.config);
      }
      return;
    }
    if (this.switchPending()) {
      await this.activateSource(this.pendingProviderId());
      return;
    }
    await this.toggle();
  }

  /** Make the chosen provider (its first model preset) the active LLM source; returns its model id and the new config. */
  private async activateSource(providerId: string): Promise<{ modelId: string; config: AppConfig } | null> {
    const cfg = this.appConfig();
    const provider = cfg?.llmProviders.find((p) => p.id === providerId);
    const mid = provider?.models[0]?.id;
    if (!cfg || !mid) {
      return null;
    }
    this.startError.set('');
    const next = await this.electron.setActiveLlmModel(mid);
    return { modelId: mid, config: next ?? { ...cfg, activeLlmModelId: mid } };
  }

  protected async toggle(): Promise<void> {
    if (this.running() || this.busy()) {
      await this.stop();
    } else {
      await this.start();
    }
  }

  /** Starts the active local server, or `modelId` when it was just made active and the config input has not caught up. */
  protected async start(modelId?: string, config?: AppConfig): Promise<void> {
    const cfg = config ?? this.appConfig();
    const mid = modelId ?? this.modelId();
    // The phase is still the previously active server's when a just-picked model is started.
    if (!cfg || !mid || (!modelId && (this.busy() || this.running()))) {
      return;
    }
    this.phase.set('starting');
    this.startError.set('');
    this.cancelled = false;
    try {
      const res = await this.electron.llamaServerStart({ modelId: mid, config: cfg });
      if (!res.ok) {
        this.phase.set('idle');
        if (!this.cancelled) {
          this.startError.set(res.error);
        }
      }
      // success path is driven by the 'running' lifecycle event
    } catch {
      this.phase.set('idle');
    }
  }

  protected async stop(): Promise<void> {
    const cfg = this.appConfig();
    const mid = this.modelId();
    if (!cfg || !mid || (!this.running() && !this.busy())) {
      return;
    }
    this.cancelled = true;
    try {
      await this.electron.llamaServerStop({ modelId: mid, config: cfg });
      // 'stopped' lifecycle event resets phase to idle
    } catch {
      this.phase.set('idle');
    }
  }

  private async probeStatus(cfg: AppConfig): Promise<void> {
    const mid = this.modelId();
    if (!mid) {
      return;
    }
    const req = ++this.probeRequestId;
    try {
      const res: LlamaServerStatusResult = await this.electron.llamaServerStatus({
        modelId: mid,
        config: cfg,
      });
      if (req !== this.probeRequestId) {
        return;
      }
      if (res.ok && res.running) {
        this.phase.set('running');
        this.startError.set('');
      } else if (res.ok && res.starting) {
        if (this.phase() !== 'downloading') {
          this.phase.set('starting');
        }
      } else if (this.busy()) {
        return;
      } else {
        this.phase.set('idle');
      }
    } catch {
      if (req !== this.probeRequestId) {
        return;
      }
      if (this.busy()) {
        return;
      }
      this.phase.set('idle');
    }
  }
}
