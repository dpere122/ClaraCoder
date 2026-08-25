import { Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  EmbeddingsLoadStatus,
  LlamaServerStatusResult,
  ManagedServerHealthState,
} from '@shared/index';
import { resolveActiveLlmConnection } from '@shared/index';
import { filter, merge } from 'rxjs';
import { ElectronService } from '../../../core/electron.service';
import {
  computeStatusPollIntervalMs,
  embeddingsStatusDotState,
  healthDotState,
  type LlamaStatusDotState,
} from './llama-status-display';

/**
 * Compact status-bar indicator with traffic-light dots:
 * - **Model** dot: managed llama.cpp chat server health (only for ``llamacpp`` provider).
 * - **Embeddings** dot: CPU FastEmbed load status (all providers).
 *
 * The embeddings dot polls the Python sidecar ``GET /embeddings/status`` endpoint, which reports
 * whether the in-process ONNX model is ``idle``, ``loading``, ``ready``, ``error``, or ``disabled``.
 */
@Component({
  selector: 'app-llama-status-indicator',
  templateUrl: './llama-status-indicator.html',
  styleUrl: './llama-status-indicator.css',
})
export class LlamaStatusIndicator {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  /** Current app config (from shell). */
  readonly appConfig = input<AppConfig | null>(null);

  /** Monotonic id so stale async status replies never overwrite newer ones. */
  private refreshSeq = 0;
  /** Require two consecutive non-ok probes before leaving ok (dampens timeout flicker). */
  private readonly chatOkExitStreak = { n: 0 };
  private readonly embedOkExitStreak = { n: 0 };
  private statusRefreshInFlight = false;
  private deferredRefreshCfg: AppConfig | null = null;
  private pollCfg: AppConfig | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Managed llama.cpp server status (chat + embed probe). Only relevant for ``llamacpp`` provider. */
  protected readonly status = signal<LlamaServerStatusResult | null>(null);
  /** Set from main-process lifecycle while HF / remote weights are being fetched. */
  private readonly modelDownloadPhase = signal(false);

  /** CPU FastEmbed embeddings status from the Python sidecar. */
  protected readonly embedStatus = signal<EmbeddingsLoadStatus | null>(null);
  private embedPollTimer: ReturnType<typeof setTimeout> | null = null;
  private embedPollCfg: AppConfig | null = null;

  /** Active provider from the app config. */
  private readonly activeProvider = computed(() => {
    const cfg = this.appConfig();
    return cfg ? resolveActiveLlmConnection(cfg)?.provider ?? null : null;
  });

  /** Show the indicator whenever there is an active LLM connection. */
  protected readonly show = computed(() => {
    const cfg = this.appConfig();
    return !!cfg && !!cfg.activeLlmModelId?.trim() && !!this.activeProvider();
  });

  /** Show the Model dot only for managed llama.cpp. */
  protected readonly showModelDot = computed(() => this.activeProvider() === 'llamacpp');

  /** True when the managed (or remote-probed) servers are considered live. */
  private readonly live = computed(() => {
    const st = this.status();
    if (!st || st.ok === false) {
      return false;
    }
    return st.running || st.remote === true;
  });

  protected readonly modelDot = computed((): LlamaStatusDotState => {
    if (this.modelDownloadPhase()) {
      return 'yellow';
    }
    const st = this.status();
    if (!st || st.ok === false || !this.live()) {
      return 'red';
    }
    return healthDotState(st.chat.health);
  });

  protected readonly embedDot = computed((): LlamaStatusDotState => {
    const es = this.embedStatus();
    if (es == null) {
      return 'red';
    }
    return embeddingsStatusDotState(es);
  });

  protected readonly modelTitle = computed(() => `Model server — ${this.dotLabel(this.modelDot())}`);
  protected readonly embedTitle = computed(() => {
    const es = this.embedStatus();
    const label = this.dotLabel(this.embedDot());
    if (es === 'loading') {
      return `Embeddings (CPU) — loading`;
    }
    if (es === 'ready') {
      return `Embeddings (CPU) — ready`;
    }
    if (es === 'disabled') {
      return `Embeddings (CPU) — disabled`;
    }
    if (es === 'error') {
      return `Embeddings (CPU) — error`;
    }
    return `Embeddings (CPU) — ${label}`;
  });

  private dotLabel(s: LlamaStatusDotState): string {
    if (s === 'green') {
      return 'ready';
    }
    if (s === 'yellow') {
      return 'loading';
    }
    return 'offline';
  }

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.stopPolling();
      this.stopEmbedPolling();
      this.clearDebounceRefresh();
    });

    merge(this.electron.llamaServerLifecycle$, this.electron.llamaServerProcessExit$)
      .pipe(
        filter((e) => {
          const cfg = this.appConfig();
          const id = cfg?.activeLlmModelId?.trim();
          return this.shouldTrackLlama() && !!id && e.modelId === id;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((e) => {
        if ('phase' in e) {
          if (e.phase === 'downloading') {
            this.modelDownloadPhase.set(true);
          } else if (e.phase === 'running' || e.phase === 'stopped' || e.phase === 'starting') {
            this.modelDownloadPhase.set(false);
          }
        } else {
          this.modelDownloadPhase.set(false);
        }
        this.scheduleDebouncedRefresh();
      });

    effect((onCleanup) => {
      const cfg = this.appConfig();
      const provider = this.activeProvider();
      if (!cfg || !provider) {
        this.refreshSeq += 1;
        this.chatOkExitStreak.n = 0;
        this.embedOkExitStreak.n = 0;
        this.deferredRefreshCfg = null;
        this.status.set(null);
        this.embedStatus.set(null);
        this.stopPolling();
        this.stopEmbedPolling();
        this.clearDebounceRefresh();
        return;
      }

      // Model dot polling: only for managed llama.cpp.
      if (provider === 'llamacpp') {
        const mid = cfg.activeLlmModelId?.trim();
        if (mid) {
          this.armPolling(cfg);
        }
      } else {
        this.stopPolling();
        this.status.set(null);
      }

      // Embeddings dot polling: all providers (CPU FastEmbed).
      this.armEmbedPolling(cfg);

      onCleanup(() => {
        this.stopPolling();
        this.stopEmbedPolling();
        this.clearDebounceRefresh();
      });
    });
  }

  private shouldTrackLlama(): boolean {
    const cfg = this.appConfig();
    return !!(cfg && resolveActiveLlmConnection(cfg)?.provider === 'llamacpp' && cfg.activeLlmModelId?.trim());
  }

  private scheduleDebouncedRefresh(): void {
    this.clearDebounceRefresh();
    this.debounceRefreshTimer = window.setTimeout(() => {
      this.debounceRefreshTimer = null;
      const cfg = this.appConfig();
      const mid = cfg?.activeLlmModelId?.trim();
      if (!cfg || !mid || !this.shouldTrackLlama()) {
        return;
      }
      void this.refreshStatus(cfg).finally(() => {
        if (this.pollCfg === cfg) {
          this.schedulePollTick();
        }
      });
    }, 320);
  }

  private clearDebounceRefresh(): void {
    if (this.debounceRefreshTimer != null) {
      window.clearTimeout(this.debounceRefreshTimer);
      this.debounceRefreshTimer = null;
    }
  }

  private armPolling(cfg: AppConfig): void {
    this.stopPolling();
    this.pollCfg = cfg;
    void this.refreshStatus(cfg).finally(() => {
      if (this.pollCfg === cfg) {
        this.schedulePollTick();
      }
    });
  }

  private schedulePollTick(): void {
    const cfg = this.pollCfg;
    if (!cfg) {
      return;
    }
    if (this.pollTimer != null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const ms = computeStatusPollIntervalMs(this.status());
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      if (this.pollCfg !== cfg) {
        return;
      }
      void this.refreshStatus(cfg).finally(() => {
        if (this.pollCfg === cfg) {
          this.schedulePollTick();
        }
      });
    }, ms);
  }

  private stopPolling(): void {
    if (this.pollTimer != null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollCfg = null;
  }

  // ---- CPU FastEmbed embeddings status polling (all providers) ----

  private armEmbedPolling(cfg: AppConfig): void {
    this.stopEmbedPolling();
    this.embedPollCfg = cfg;
    void this.refreshEmbedStatus().finally(() => {
      if (this.embedPollCfg === cfg) {
        this.scheduleEmbedPollTick();
      }
    });
  }

  private scheduleEmbedPollTick(): void {
    const cfg = this.embedPollCfg;
    if (!cfg) {
      return;
    }
    if (this.embedPollTimer != null) {
      window.clearTimeout(this.embedPollTimer);
      this.embedPollTimer = null;
    }
    // Poll faster while loading; slow down once ready or errored.
    const es = this.embedStatus();
    const ms = es === 'loading' || es === 'idle' ? 2_500 : 10_000;
    this.embedPollTimer = window.setTimeout(() => {
      this.embedPollTimer = null;
      if (this.embedPollCfg !== cfg) {
        return;
      }
      void this.refreshEmbedStatus().finally(() => {
        if (this.embedPollCfg === cfg) {
          this.scheduleEmbedPollTick();
        }
      });
    }, ms);
  }

  private stopEmbedPolling(): void {
    if (this.embedPollTimer != null) {
      window.clearTimeout(this.embedPollTimer);
      this.embedPollTimer = null;
    }
    this.embedPollCfg = null;
  }

  private async refreshEmbedStatus(): Promise<void> {
    try {
      const r = await this.electron.embeddingsStatus();
      if (r.ok) {
        this.embedStatus.set(r.status);
      } else {
        this.embedStatus.set(null);
      }
    } catch {
      this.embedStatus.set(null);
    }
  }

  // ---- Managed llama.cpp status polling (llamacpp only) ----

  private async refreshStatus(cfg: AppConfig): Promise<void> {
    const mid = cfg.activeLlmModelId?.trim();
    if (!mid) {
      return;
    }
    if (this.statusRefreshInFlight) {
      this.deferredRefreshCfg = cfg;
      return;
    }
    this.statusRefreshInFlight = true;
    const seq = ++this.refreshSeq;
    try {
      const r = await this.electron.llamaServerStatus({ modelId: mid, config: cfg });
      this.commitSmoothedStatus(r, seq);
    } catch {
      if (seq === this.refreshSeq) {
        /* keep last status on transient IPC failure */
      }
    } finally {
      this.statusRefreshInFlight = false;
      const next = this.deferredRefreshCfg;
      this.deferredRefreshCfg = null;
      if (next) {
        void this.refreshStatus(next);
      }
    }
  }

  private smoothHealth(
    prevDisplayed: ManagedServerHealthState | undefined,
    raw: ManagedServerHealthState,
    okExitStreak: { n: number },
  ): ManagedServerHealthState {
    if (raw === 'ok') {
      okExitStreak.n = 0;
      return 'ok';
    }
    if (raw === 'stopped') {
      okExitStreak.n = 0;
      return 'stopped';
    }
    if (prevDisplayed === 'ok') {
      okExitStreak.n += 1;
      return okExitStreak.n >= 2 ? raw : 'ok';
    }
    okExitStreak.n = 0;
    return raw;
  }

  private commitSmoothedStatus(raw: LlamaServerStatusResult, seq: number): void {
    if (seq !== this.refreshSeq) {
      return;
    }
    if (!raw.ok) {
      this.chatOkExitStreak.n = 0;
      this.embedOkExitStreak.n = 0;
      this.status.set(raw);
      return;
    }
    const remoteLive = raw.ok === true && raw.remote === true;
    if (!raw.running && !remoteLive) {
      this.chatOkExitStreak.n = 0;
      this.embedOkExitStreak.n = 0;
      this.status.set(raw);
      return;
    }

    const prev = this.status();
    if (prev && prev.ok === true && raw.modelId !== prev.modelId) {
      this.chatOkExitStreak.n = 0;
      this.embedOkExitStreak.n = 0;
    }

    const prevOk = prev && prev.ok === true;
    const prevChat = prevOk ? prev.chat.health : undefined;
    const chatHealth = this.smoothHealth(prevChat, raw.chat.health, this.chatOkExitStreak);

    let embed = raw.embed;
    if (embed) {
      const prevEmb = prevOk && prev.embed ? prev.embed.health : undefined;
      embed = { ...embed, health: this.smoothHealth(prevEmb, embed.health, this.embedOkExitStreak) };
    }

    this.status.set({
      ...raw,
      chat: { ...raw.chat, health: chatHealth },
      embed,
    });
  }
}
