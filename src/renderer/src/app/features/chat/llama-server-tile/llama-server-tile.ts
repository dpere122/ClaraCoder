import { Component, computed, DestroyRef, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AppConfig, LlamaServerStatusResult, ManagedServerHealthState } from '@shared/index';
import { resolveActiveLlmConnection } from '@shared/index';
import { LucideAngularModule } from 'lucide-angular';
import { filter, merge, switchMap, tap, timer } from 'rxjs';
import { ElectronService } from '../../../core/electron.service';
import {
  computeStatusPollIntervalMs,
  llamaCrystalAggregateFromPayload,
  type LlamaCrystalAggregate,
} from './llama-connection-display';
import { LlamaCrystalView } from './llama-crystal-view';

@Component({
  selector: 'app-llama-server-tile',
  imports: [LucideAngularModule, LlamaCrystalView],
  templateUrl: './llama-server-tile.html',
  styleUrl: './llama-server-tile.css',
})
export class LlamaServerTile {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

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

  /** Current app config (from shell). */
  readonly appConfig = input<AppConfig | null>(null);
  /** True while the active conversation is awaiting assistant output (IPC stream in flight). */
  readonly llmStreamActive = input(false);
  /** When set, harness crystal pulses only match this conversation (ignore background streams). */
  readonly activeConversationId = input<string | null>(null);
  /** Which shell column currently hosts this tile (used for drag-and-dock). */
  readonly dockTarget = input<'conversations' | 'workspace'>('conversations');
  readonly dockTargetChange = output<'conversations' | 'workspace'>();

  protected readonly inflight = signal<'start' | 'stop' | null>(null);
  protected readonly lastError = signal('');
  protected readonly status = signal<LlamaServerStatusResult | null>(null);
  protected readonly recentOutput = signal(false);
  protected readonly harnessCrystalPulse = signal<'positive' | 'negative' | null>(null);
  protected readonly crystalShakeNonce = signal(0);
  private harnessCrystalClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set from main-process lifecycle while HF / remote weights are being fetched. */
  private readonly modelDownloadPhase = signal(false);
  private dockDragActive = false;

  protected readonly crystalAggregate = computed((): LlamaCrystalAggregate => {
    const pulse = this.harnessCrystalPulse();
    if (pulse === 'positive') {
      return 'feedbackPositive';
    }
    if (pulse === 'negative') {
      return 'feedbackNegative';
    }
    if (this.modelDownloadPhase()) {
      return 'modelDownload';
    }
    const st = this.status();
    if (!st || st.ok === false) {
      return llamaCrystalAggregateFromPayload(null);
    }
    return llamaCrystalAggregateFromPayload(st);
  });

  /** Embedding managed server is present on status and healthy. */
  protected readonly embedModelReady = computed(() => {
    const st = this.status();
    if (!st || st.ok !== true) {
      return false;
    }
    return st.embed != null && st.embed.health === 'ok';
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.harnessCrystalClearTimer != null) {
        clearTimeout(this.harnessCrystalClearTimer);
        this.harnessCrystalClearTimer = null;
      }
      document.body.classList.remove('llama-dock-drag--active');
      this.clearLlamaDockHover();
      this.dockDragActive = false;
    });

    this.electron.harnessCrystal$
      .pipe(
        filter((m) => {
          const active = this.activeConversationId();
          return !active || m.conversationId === active;
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((m) => {
        if (this.harnessCrystalClearTimer != null) {
          clearTimeout(this.harnessCrystalClearTimer);
          this.harnessCrystalClearTimer = null;
        }
        this.harnessCrystalPulse.set(m.polarity);
        this.crystalShakeNonce.update((n) => n + 1);
        this.harnessCrystalClearTimer = window.setTimeout(() => {
          this.harnessCrystalPulse.set(null);
          this.harnessCrystalClearTimer = null;
        }, 750);
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
      const show = cfg && resolveActiveLlmConnection(cfg)?.provider === 'llamacpp';
      if (!show || !cfg) {
        this.refreshSeq += 1;
        this.chatOkExitStreak.n = 0;
        this.embedOkExitStreak.n = 0;
        this.deferredRefreshCfg = null;
        this.status.set(null);
        this.stopPolling();
        this.clearDebounceRefresh();
        return;
      }

      const mid = cfg.activeLlmModelId?.trim();
      if (!mid) {
        return;
      }

      this.armPolling(cfg);

      const subOut = this.electron.llamaServerOutput$
        .pipe(
          filter((m) => m.modelId === mid),
          tap(() => this.recentOutput.set(true)),
          switchMap(() => timer(480)),
          tap(() => this.recentOutput.set(false)),
        )
        .subscribe();

      onCleanup(() => {
        subOut.unsubscribe();
        this.stopPolling();
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

  protected showTile(): boolean {
    const cfg = this.appConfig();
    return !!cfg && resolveActiveLlmConnection(cfg)?.provider === 'llamacpp';
  }

  protected async refreshStatus(cfg: AppConfig): Promise<void> {
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
      this.clearInflightIfMatches(raw);
      return;
    }
    if (!raw.running) {
      this.chatOkExitStreak.n = 0;
      this.embedOkExitStreak.n = 0;
      this.status.set(raw);
      this.clearInflightIfMatches(raw);
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
    this.clearInflightIfMatches(raw);
  }

  private clearInflightIfMatches(raw: LlamaServerStatusResult): void {
    const p = this.inflight();
    if (!p) {
      return;
    }
    if (p === 'start') {
      if (!raw.ok) {
        this.inflight.set(null);
      } else if (raw.running) {
        this.inflight.set(null);
      }
      return;
    }
    if (p === 'stop' && (!raw.ok || !raw.running)) {
      this.inflight.set(null);
    }
  }

  protected startDisabled(): boolean {
    const st = this.status();
    if (!st || st.ok === false) {
      return true;
    }
    if (st.running) {
      return true;
    }
    return this.inflight() === 'start';
  }

  protected stopDisabled(): boolean {
    const st = this.status();
    if (!st || st.ok === false) {
      return true;
    }
    if (!st.running) {
      return true;
    }
    return this.inflight() === 'stop';
  }

  protected async onStart(): Promise<void> {
    const cfg = this.appConfig();
    const mid = cfg?.activeLlmModelId?.trim();
    if (!cfg || !mid) {
      return;
    }
    this.inflight.set('start');
    this.lastError.set('');
    const r = await this.electron.llamaServerStart({ modelId: mid, config: cfg });
    if (!r.ok) {
      this.lastError.set(r.error);
      this.inflight.set(null);
    }
    await this.refreshStatus(cfg);
    if (this.pollCfg === cfg) {
      this.schedulePollTick();
    }
  }

  protected async onStop(): Promise<void> {
    const cfg = this.appConfig();
    const mid = cfg?.activeLlmModelId?.trim();
    if (!cfg || !mid) {
      return;
    }
    this.inflight.set('stop');
    await this.electron.llamaServerStop({ modelId: mid, config: cfg });
    await this.refreshStatus(cfg);
    if (this.pollCfg === cfg) {
      this.schedulePollTick();
    }
  }

  protected onDockHandlePointerDown(ev: PointerEvent): void {
    ev.preventDefault();
    const t = ev.currentTarget;
    if (!(t instanceof HTMLElement)) {
      return;
    }
    this.dockDragActive = true;
    try {
      t.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.add('llama-dock-drag--active');
  }

  protected onDockHandlePointerMove(ev: PointerEvent): void {
    if (!this.dockDragActive) {
      return;
    }
    this.updateLlamaDockHover(ev.clientX, ev.clientY);
  }

  protected onDockHandlePointerUp(ev: PointerEvent): void {
    if (!this.dockDragActive) {
      return;
    }
    this.dockDragActive = false;
    document.body.classList.remove('llama-dock-drag--active');
    this.clearLlamaDockHover();
    const t = ev.currentTarget;
    if (t instanceof HTMLElement) {
      try {
        if (t.hasPointerCapture(ev.pointerId)) {
          t.releasePointerCapture(ev.pointerId);
        }
      } catch {
        /* ignore */
      }
    }
    const zone = this.resolveLlamaDockZoneAtPoint(ev.clientX, ev.clientY);
    if (zone && zone !== this.dockTarget()) {
      this.dockTargetChange.emit(zone);
    }
  }

  private resolveLlamaDockZoneAtPoint(clientX: number, clientY: number): 'conversations' | 'workspace' | undefined {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const el of stack) {
      if (!(el instanceof Element)) {
        continue;
      }
      const host = el.closest('[data-llama-dock]');
      if (!(host instanceof HTMLElement)) {
        continue;
      }
      const v = host.dataset['llamaDock'];
      if (v === 'conversations' || v === 'workspace') {
        return v;
      }
    }
    return undefined;
  }

  private clearLlamaDockHover(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-llama-dock]')) {
      el.classList.remove('llama-dock-zone--hover');
    }
  }

  private updateLlamaDockHover(clientX: number, clientY: number): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-llama-dock]')) {
      const r = el.getBoundingClientRect();
      const over = clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
      el.classList.toggle('llama-dock-zone--hover', over);
    }
  }
}
