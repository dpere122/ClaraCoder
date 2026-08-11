import { Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  LlamaServerLifecycleEvent,
  LlamaServerProcessExitEvent,
  LlamaServerStatusResult,
} from '@shared/index';
import { findLlmModelLocation, isPinnedLlamaCppLocalProviderId } from '@shared/index';
import { filter, merge } from 'rxjs';
import { ElectronService } from '../../../core/electron.service';
import { LlamaStatusIndicator } from '../llama-status-indicator/llama-status-indicator';

type ManagedLlamaPhase = 'idle' | 'starting' | 'downloading' | 'running';

/**
 * Start/Stop controls for the pinned managed ``llama-server`` on this machine.
 * Lives in the workspace panel below the system prompt area; shown only when
 * the active LLM provider is the managed local llama row. The model + embeddings
 * health dots ({@link LlamaStatusIndicator}) sit next to the Start/Stop button.
 */
@Component({
  selector: 'app-managed-llama-controls',
  imports: [LlamaStatusIndicator],
  templateUrl: './managed-llama-controls.html',
  styleUrl: './managed-llama-controls.css',
})
export class ManagedLlamaControlsComponent {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  /** Live app config from the shell; drives the active model id and start/stop IPC calls. */
  readonly appConfig = input<AppConfig | null>(null);

  protected readonly phase = signal<ManagedLlamaPhase>('idle');
  protected readonly startError = signal<string | null>(null);

  /** Active model location; null when not the managed local llama provider. */
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
    if (!loc || loc.provider.provider !== 'llamacpp' || !isPinnedLlamaCppLocalProviderId(loc.provider.id)) {
      return null;
    }
    return loc;
  });

  protected readonly show = computed(() => this.activeLocation() !== null);

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

  protected readonly statusLabel = computed(() => {
    const err = this.startError();
    if (err) {
      return err;
    }
    const p = this.phase();
    if (p === 'running') {
      return 'Healthy';
    }
    if (p === 'downloading') {
      return 'Downloading…';
    }
    if (p === 'starting') {
      return 'Starting…';
    }
    return 'Not running';
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
            this.startError.set(null);
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

    effect((onCleanup) => {
      const cfg = this.appConfig();
      if (!cfg || !this.show()) {
        this.phase.set('idle');
        this.startError.set(null);
        return;
      }
      void this.probeStatus(cfg);
      onCleanup(() => {
        /* nothing to tear down between probes; lifecycle stream is owned by the constructor subscription */
      });
    });
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
    this.startError.set(null);
    try {
      const res = await this.electron.llamaServerStart({ modelId: mid, config: cfg });
      if (!res.ok) {
        this.phase.set('idle');
        this.startError.set(res.error);
      }
      // success path is driven by the 'running' lifecycle event
    } catch (e) {
      this.phase.set('idle');
      this.startError.set(e instanceof Error ? e.message : String(e));
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
    try {
      const res: LlamaServerStatusResult = await this.electron.llamaServerStatus({
        modelId: mid,
        config: cfg,
      });
      if (res.ok && res.running) {
        this.phase.set('running');
      } else {
        this.phase.set('idle');
      }
    } catch {
      this.phase.set('idle');
    }
  }
}
