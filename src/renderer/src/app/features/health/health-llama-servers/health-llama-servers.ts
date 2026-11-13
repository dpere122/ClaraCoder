import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type {
  AppConfig,
  LlamaServerInstancePhase,
  LlamaServerStreamKind,
  ModelManagerFileEntry,
} from '@shared/index';
import { managedLlamaSourceDisplayName } from '@shared/index';
import { subagentSources } from '@shared/subagent-sources';
import { ElectronService } from '../../../core/electron.service';
import { buildXtermThemeFromCssVars } from '../../workspace-terminal/xterm-theme-from-css';

/** Console text kept per server in this window; older output is dropped past this (main keeps the same). */
const CONSOLE_MAX_CHARS = 400_000;

interface ServerRow {
  /** One console: a model's chat server, or its embedding server. */
  key: string;
  modelId: string;
  stream: LlamaServerStreamKind;
  label: string;
  phase: LlamaServerInstancePhase;
}

function consoleKey(modelId: string, stream: LlamaServerStreamKind): string {
  return `${modelId}\n${stream}`;
}

/**
 * Health → Runtime → Local servers: every local model the app can start, in a list, and the console
 * of the selected one beside it. Several servers can run at once, so each has its own console; main
 * keeps what each printed since its last start, so this window shows it even when opened later.
 */
@Component({
  selector: 'app-health-llama-servers',
  templateUrl: './health-llama-servers.html',
  styleUrl: './health-llama-servers.css',
})
export class HealthLlamaServers implements AfterViewInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly terminalHost = viewChild<ElementRef<HTMLElement>>('terminalHost');

  private readonly config = signal<AppConfig | null>(null);
  /** Local model files, for the names of sources without a custom name. */
  private readonly inventory = signal<ModelManagerFileEntry[]>([]);
  private readonly phases = signal<Readonly<Record<string, LlamaServerInstancePhase>>>({});
  /** What each console has printed, by console key. Not a signal: the terminal is written to directly. */
  private readonly buffers = new Map<string, string>();
  /** Console keys that hold any output (what makes an embedding server's row appear). */
  private readonly withOutput = signal<ReadonlySet<string>>(new Set());
  private readonly selectedKey = signal('');

  /** The viewport sits on the newest line, so new output keeps it there. */
  protected readonly atBottom = signal(true);
  protected readonly atTop = signal(true);

  private terminal: Terminal | null = null;
  private fit: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewport: HTMLElement | null = null;
  private readonly onViewportScroll = (): void => this.readScrollState();

  /** A row per local model with a run command, and one more for a model whose embedding server has printed. */
  protected readonly rows = computed<ServerRow[]>(() => {
    const config = this.config();
    if (!config) {
      return [];
    }
    const phases = this.phases();
    const withOutput = this.withOutput();
    return subagentSources(config.llmProviders, (provider) => managedLlamaSourceDisplayName(provider, this.inventory()))
      .filter((source) => source.launchable)
      .flatMap((source) => {
        const modelId = source.connectionId;
        const phase = phases[modelId] ?? 'off';
        const chat: ServerRow = { key: consoleKey(modelId, 'chat'), modelId, stream: 'chat', label: source.label, phase };
        const embedKey = consoleKey(modelId, 'embed');
        return withOutput.has(embedKey)
          ? [chat, { key: embedKey, modelId, stream: 'embed' as const, label: `${source.label} · embeddings`, phase }]
          : [chat];
      });
  });

  /** The row whose console shows: the one picked, else the first that is up, else the first. */
  protected readonly selected = computed<ServerRow | null>(() => {
    const rows = this.rows();
    return (
      rows.find((row) => row.key === this.selectedKey()) ??
      rows.find((row) => row.phase !== 'off') ??
      rows[0] ??
      null
    );
  });

  protected readonly hasOutput = computed(() => {
    const row = this.selected();
    return !!row && this.withOutput().has(row.key);
  });

  constructor() {
    this.electron.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((config) => this.config.set(config));
    void this.electron.loadConfig().then((config) => this.config.set(config));

    this.electron.llamaServerOutput$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((chunk) => {
      this.append(consoleKey(chunk.modelId, chunk.stream), chunk.data);
    });
    this.electron.llamaServerLifecycle$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((event) => {
      if (event.phase === 'starting') {
        // A fresh start is a fresh console (main clears its copy too, then sends its "Starting" line).
        this.clear(event.modelId);
      }
      this.setPhase(event.modelId, event.phase === 'running' ? 'running' : event.phase === 'stopped' ? 'off' : 'loading');
    });
    // What the servers printed, and their states, from before this window was listening.
    void this.electron.llamaServerConsoles().then((snapshots) => {
      for (const snapshot of snapshots) {
        this.setPhase(snapshot.modelId, snapshot.phase);
        for (const { stream, text } of snapshot.streams) {
          const key = consoleKey(snapshot.modelId, stream);
          // Output that arrived while the snapshot was on its way is already at the end of it.
          const live = this.buffers.get(key) ?? '';
          this.setBuffer(key, text.endsWith(live) ? text : text + live);
        }
      }
      this.showSelected();
    });

    effect(() => {
      const dir = this.config()?.modelManager?.customModelsDir?.trim() ?? '';
      untracked(() => void this.loadInventory(dir));
    });
    // Another server picked (or the first one known): its console replaces what the terminal shows.
    effect(() => {
      this.selected()?.key;
      untracked(() => this.showSelected());
    });
  }

  ngAfterViewInit(): void {
    const host = this.terminalHost()?.nativeElement;
    if (!host) {
      return;
    }
    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 20_000,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      theme: buildXtermThemeFromCssVars(getComputedStyle(document.documentElement)),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // Read-only, so Ctrl+C (and Ctrl+Shift+C) copies the selection.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection());
        return false;
      }
      return true;
    });
    terminal.open(host);
    this.terminal = terminal;
    this.fit = fit;
    terminal.onScroll(() => this.readScrollState());
    // The wheel and the scrollbar move xterm's own viewport element.
    this.viewport = host.querySelector<HTMLElement>('.xterm-viewport');
    this.viewport?.addEventListener('scroll', this.onViewportScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fitTerminal());
      this.resizeObserver.observe(host);
    }
    this.fitTerminal();
    this.showSelected();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.viewport?.removeEventListener('scroll', this.onViewportScroll);
    this.terminal?.dispose();
    this.terminal = null;
  }

  protected select(row: ServerRow): void {
    this.selectedKey.set(row.key);
  }

  protected scrollToTop(): void {
    this.terminal?.scrollToTop();
    this.readScrollState();
  }

  protected scrollPage(pages: number): void {
    this.terminal?.scrollPages(pages);
    this.readScrollState();
  }

  /** Back to the newest line, where new output keeps the view. */
  protected scrollToLatest(): void {
    this.terminal?.scrollToBottom();
    this.readScrollState();
  }

  private readScrollState(): void {
    const buffer = this.terminal?.buffer.active;
    if (!buffer) {
      return;
    }
    this.atBottom.set(buffer.viewportY >= buffer.baseY);
    this.atTop.set(buffer.viewportY <= 0);
  }

  private fitTerminal(): void {
    try {
      this.fit?.fit();
    } catch {
      // The host has no size yet (its tab is hidden); the next resize fits it.
    }
    this.readScrollState();
  }

  private setPhase(modelId: string, phase: LlamaServerInstancePhase): void {
    this.phases.update((current) => ({ ...current, [modelId]: phase }));
  }

  private setBuffer(key: string, text: string): void {
    this.buffers.set(key, text.slice(-CONSOLE_MAX_CHARS));
    if (text && !this.withOutput().has(key)) {
      this.withOutput.update((current) => new Set(current).add(key));
    }
  }

  private append(key: string, data: string): void {
    this.setBuffer(key, (this.buffers.get(key) ?? '') + data);
    if (this.terminal && untracked(() => this.selected())?.key === key) {
      // xterm keeps the view on the newest line only while it is already there.
      this.terminal.write(data, () => this.readScrollState());
    }
  }

  private clear(modelId: string): void {
    const keys = [consoleKey(modelId, 'chat'), consoleKey(modelId, 'embed')];
    for (const key of keys) {
      this.buffers.delete(key);
    }
    this.withOutput.update((current) => new Set([...current].filter((key) => !keys.includes(key))));
    if (keys.includes(untracked(() => this.selected())?.key ?? '')) {
      this.showSelected();
    }
  }

  /** Puts the selected server's console in the terminal, at its newest line. */
  private showSelected(): void {
    const terminal = this.terminal;
    if (!terminal) {
      return;
    }
    const row = untracked(() => this.selected());
    terminal.reset();
    const text = row ? (this.buffers.get(row.key) ?? '') : '';
    if (text) {
      terminal.write(text, () => {
        terminal.scrollToBottom();
        this.readScrollState();
      });
    } else {
      this.readScrollState();
    }
  }

  private async loadInventory(customDir: string): Promise<void> {
    if (!customDir) {
      this.inventory.set([]);
      return;
    }
    const result = await this.electron.modelManagerListCustomModels({ customDir }).catch(() => null);
    this.inventory.set(result?.ok ? result.models : []);
  }
}
