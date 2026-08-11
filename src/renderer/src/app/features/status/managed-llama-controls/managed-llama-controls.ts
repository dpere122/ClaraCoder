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
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
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
  isPinnedLlamaCppLocalProviderId,
  isPinnedLlamaServerUrlProviderId,
  isPinnedLmStudioProviderId,
  isPinnedLlmSourceId,
  managedLlamaSourceDisplayName,
} from '@shared/index';
import { filter, merge } from 'rxjs';
import { ElectronService } from '../../../core/electron.service';
import { LlamaStatusIndicator } from '../llama-status-indicator/llama-status-indicator';

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
 * the workspace panel below the system prompt area. A dropdown lists every
 * LLM source and switches the active one; the Start/Stop button is enabled
 * only for a managed (non-URL-only) llamacpp source — i.e. the local llama
 * server — and disabled for everything else. The model + embeddings health
 * dots ({@link LlamaStatusIndicator}) sit beside the button. An inline
 * loading spinner shows while the local model inventory (source labels) is
 * being fetched.
 */
@Component({
  selector: 'app-managed-llama-controls',
  imports: [FormsModule, LlamaStatusIndicator, NgxSpinnerComponent],
  templateUrl: './managed-llama-controls.html',
  styleUrl: './managed-llama-controls.css',
})
export class ManagedLlamaControlsComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly inj = inject(Injector);
  private readonly ngxSpinner = inject(NgxSpinnerService);

  /** Live app config from the shell; drives the active source and start/stop IPC calls. */
  readonly appConfig = input<AppConfig | null>(null);

  protected readonly phase = signal<ManagedLlamaPhase>('idle');

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

  /** Sources listed in the dropdown, pinned rows first (same order as Settings → Models). */
  protected readonly sources = computed<LlmProviderConfig[]>(() => {
    const cfg = this.appConfig();
    if (!cfg) {
      return [];
    }
    const list = cfg.llmProviders;
    const pinLm = list.find((p) => isPinnedLmStudioProviderId(p.id));
    const pinUrl = list.find((p) => isPinnedLlamaServerUrlProviderId(p.id));
    const pinLocal = list.find((p) => isPinnedLlamaCppLocalProviderId(p.id));
    const rest = list.filter((p) => !isPinnedLlmSourceId(p.id));
    const head: LlmProviderConfig[] = [];
    if (pinLm) {
      head.push(pinLm);
    }
    if (pinUrl) {
      head.push(pinUrl);
    }
    if (pinLocal) {
      head.push(pinLocal);
    }
    return [...head, ...rest];
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

  /** Active model location; null when the active source is not a managed local llama server. */
  private readonly activeLocation = computed(() => {
    const cfg = this.appConfig();
    if (!cfg) {
      return null;
    }
    const mid = cfg.activeLlmModelId?.trim();
    if (!mid) {
      return null;
    }
    const loc = findLlmModelLocation(cfg.llmProviders, mid);
    // Any managed (non-URL-only) llamacpp provider gets Start/Stop: the pinned
    // local default plus user-added custom llamacpp sources. The pinned URL-only
    // remote row is excluded (it Connects to an already-running server).
    if (!loc || loc.provider.provider !== 'llamacpp' || isPinnedLlamaServerUrlProviderId(loc.provider.id)) {
      return null;
    }
    return loc;
  });

  /** Whether the active source is a local llama server (Start/Stop eligible). */
  protected readonly isLocalLlama = computed(() => this.activeLocation() !== null);

  protected readonly modelId = computed(() => this.activeLocation()?.model.id ?? '');

  protected readonly chatRunCommand = computed(
    () => this.activeLocation()?.model.llamaCppManaged?.chatRunCommand ?? '',
  );

  protected readonly running = computed(() => this.phase() === 'running');
  protected readonly busy = computed(
    () => this.phase() === 'starting' || this.phase() === 'downloading',
  );

  protected readonly actionLabel = computed(() => {
    if (this.running()) {
      return 'Stop';
    }
    if (this.busy()) {
      return 'Starting…';
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
          } else if (ev.phase === 'stopped') {
            this.phase.set('idle');
          }
        } else {
          // process exit while not transitioning to running -> back to idle
          if (this.phase() !== 'running') {
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

  /** Display name for a source option in the dropdown (model name for llama sources, else stored name). */
  protected sourceLabel(provider: LlmProviderConfig): string {
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

  /** Switch the active LLM source to the chosen provider (its first model preset). */
  protected async onSourceChange(providerId: string): Promise<void> {
    const cfg = this.appConfig();
    const provider = cfg?.llmProviders.find((p) => p.id === providerId);
    const mid = provider?.models[0]?.id;
    if (!mid) {
      return;
    }
    await this.electron.setActiveLlmModel(mid);
  }

  protected async toggle(): Promise<void> {
    if (this.running()) {
      await this.stop();
    } else {
      await this.start();
    }
  }

  protected async start(): Promise<void> {
    const cfg = this.appConfig();
    const mid = this.modelId();
    if (!cfg || !mid || this.busy() || this.running()) {
      return;
    }
    this.phase.set('starting');
    try {
      const res = await this.electron.llamaServerStart({ modelId: mid, config: cfg });
      if (!res.ok) {
        this.phase.set('idle');
      }
      // success path is driven by the 'running' lifecycle event
    } catch {
      this.phase.set('idle');
    }
  }

  protected async stop(): Promise<void> {
    const cfg = this.appConfig();
    const mid = this.modelId();
    if (!cfg || !mid || !this.running()) {
      return;
    }
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
      } else {
        this.phase.set('idle');
      }
    } catch {
      if (req !== this.probeRequestId) {
        return;
      }
      this.phase.set('idle');
    }
  }
}
