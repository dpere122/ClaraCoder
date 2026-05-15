import {
  Component,
  DestroyRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type {
  AppConfig,
  LlamaServerStreamKind,
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
} from '@shared/index';
import { findLlmModelLocation, resolveActiveLlmConnection } from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { buildXtermThemeFromCssVars } from './xterm-theme-from-css';

/** Prefix for read-only llama.cpp server log tabs (not PTYs). */
const LLAMA_SERVER_TAB_PREFIX = 'managed-llama-server-tab';
const LLAMA_XTERM_SESSION_PREFIX = 'llama-log';

interface PtyTerminalTab {
  readonly id: string;
  sessionId: string | null;
  title: string;
  /** Set when the main process could not start a PTY for this tab. */
  spawnError?: string;
  /** True while ``workspace-pty-spawn`` is in flight (shows a "starting" placeholder). */
  spawning?: boolean;
}

interface MergedTab {
  readonly id: string;
  kind: 'pty';
  sessionId: string | null;
  title: string;
}

interface LlamaTerminalTab {
  readonly id: string;
  readonly modelId: string;
  readonly stream: LlamaServerStreamKind;
  readonly title: string;
}

interface XtermInstance {
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  sessionId: string;
}

@Component({
  selector: 'app-workspace-terminal-dock',
  standalone: true,
  templateUrl: './workspace-terminal-dock.html',
  styleUrl: './workspace-terminal-dock.css',
  encapsulation: ViewEncapsulation.None,
})
export class WorkspaceTerminalDockComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly xterms = new Map<string, XtermInstance>();
  /** PTY session id → shell tab id (avoids scanning every chunk). */
  private readonly ptySessionToTabId = new Map<string, string>();
  /** Pending llama bytes keyed by llama tab id until xterm mounts. */
  private readonly llamaBacklogByTab = new Map<string, string>();
  private readonly spawningTabs = new Set<string>();
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf = 0;
  private panelDrag: { startY: number; startH: number } | null = null;
  private panelDragListenersActive = false;
  private destroyed = false;
  private static readonly LLAMA_BACKLOG_MAX = 400_000;

  private readonly boundPanelDragMove = (e: MouseEvent) => this.onResizeHandleMove(e);
  private readonly boundPanelDragUp = () => this.endPanelDrag();

  readonly workspacePath = input<string>('');
  /** When the active model uses llama.cpp, show a dedicated llama-server log tab. */
  readonly appConfig = input<AppConfig | null>(null);

  readonly expanded = signal(false);
  readonly panelHeightPx = signal(260);
  readonly ptyTabs = signal<PtyTerminalTab[]>([]);
  readonly llamaTabs = signal<LlamaTerminalTab[]>([]);
  readonly activeTabId = signal<string | null>(null);

  private lastWorkspacePath = '';

  readonly hasWorkspace = computed(() => this.workspacePath().trim().length > 0);

  readonly showLlamaServerTab = computed(() => {
    const c = this.appConfig();
    return !!(c && resolveActiveLlmConnection(c)?.provider === 'llamacpp');
  });

  readonly activeLlmModelId = computed(() => this.appConfig()?.activeLlmModelId?.trim() ?? '');

  readonly hasDockPanelContent = computed(() => this.hasWorkspace() || this.showLlamaServerTab());

  /** Shell tabs first; llama tab is rendered separately at the trailing edge (after +). */
  readonly ptyDisplayTabs = computed((): MergedTab[] =>
    this.ptyTabs().map((t) => ({
      id: t.id,
      kind: 'pty' as const,
      sessionId: t.sessionId,
      title: t.title,
    })),
  );

  readonly tabStripCount = computed(() => {
    return this.ptyTabs().length + this.llamaTabs().length;
  });

  readonly allManagedTabIds = computed((): string[] => {
    const ids = this.ptyTabs().map((t) => t.id);
    ids.push(...this.llamaTabs().map((t) => t.id));
    return ids;
  });

  constructor() {
    this.electron.workspacePtyData$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed) {
        return;
      }
      const tabId = this.ptySessionToTabId.get(msg.sessionId);
      const inst = tabId ? this.xterms.get(tabId) : undefined;
      if (inst && inst.sessionId === msg.sessionId) {
        inst.terminal.write(msg.data);
        return;
      }
      for (const i of this.xterms.values()) {
        if (i.sessionId === msg.sessionId) {
          i.terminal.write(msg.data);
          break;
        }
      }
    });

    this.electron.workspacePtyExit$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
    if (this.destroyed) {
      return;
    }
    const tabIdHint = this.ptySessionToTabId.get(msg.sessionId);
    const preferred = tabIdHint != null ? this.xterms.get(tabIdHint) : undefined;
    const entry =
      preferred?.sessionId === msg.sessionId
        ? ([tabIdHint!, preferred] as const)
        : [...this.xterms.entries()].find(([, inst]) => inst.sessionId === msg.sessionId);
    if (entry) {
      const [tabId, inst] = entry;
      inst.terminal.writeln('');
      inst.terminal.writeln(`\x1b[90m[Exit code ${msg.exitCode}]\x1b[0m`);
      this.ptySessionToTabId.delete(msg.sessionId);
      this.disposeXterm(tabId);
    }
      this.ptyTabs.update((list) =>
        list.map((t) => {
          if (t.sessionId !== msg.sessionId) {
            return t;
          }
          const base = t.title.replace(/ \(exited\)$/, '');
          return { ...t, sessionId: null, title: `${base} (exited)` };
        }),
      );
      void this.ensureActiveTabSession();
    });

    this.electron.llamaServerOutput$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg: LlamaServerOutputEvent) => {
      if (this.destroyed || msg.modelId !== this.activeLlmModelId()) {
        return;
      }
      this.writeLlamaServerChunk(msg.modelId, msg.stream, msg.data);
    });

    this.electron.llamaServerProcessExit$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((msg: LlamaServerProcessExitEvent) => {
        if (this.destroyed || msg.modelId !== this.activeLlmModelId()) {
          return;
        }
        const tabId = this.llamaTabId(msg.modelId, msg.stream);
        this.withLlamaTerminal(tabId, (inst) => {
          inst.terminal.writeln('');
          const bits = [
            msg.code != null ? `code ${msg.code}` : null,
            msg.signal ? `signal ${msg.signal}` : null,
          ]
            .filter(Boolean)
            .join(', ');
          inst.terminal.writeln(
            `\x1b[31m[${msg.stream} process ended${bits ? ` (${bits})` : ''}]\x1b[0m`,
          );
        });
      });

    this.electron.llamaServerLifecycle$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev: LlamaServerLifecycleEvent) => {
        if (this.destroyed || ev.modelId !== this.activeLlmModelId()) {
          return;
        }
        const llamaTabIds = this.llamaTabs()
          .filter((t) => t.modelId === ev.modelId)
          .map((t) => t.id);
        if (llamaTabIds.length === 0) {
          return;
        }
        if (ev.phase === 'starting') {
          for (const tabId of llamaTabIds) {
            this.llamaBacklogByTab.delete(tabId);
            this.withLlamaTerminal(tabId, (inst) => {
              inst.terminal.clear();
              inst.terminal.writeln('\x1b[90m[Starting llama-server…]\x1b[0m');
            });
          }
        } else if (ev.phase === 'downloading') {
          for (const tabId of llamaTabIds) {
            this.withLlamaTerminal(tabId, (inst) => {
              inst.terminal.writeln('\x1b[36m[Downloading model weights…]\x1b[0m');
            });
          }
        } else if (ev.phase === 'running') {
          for (const tabId of llamaTabIds) {
            this.withLlamaTerminal(tabId, (inst) => {
              inst.terminal.writeln('\x1b[32m[llama-server ready]\x1b[0m');
            });
          }
        } else if (ev.phase === 'stopped') {
          for (const tabId of llamaTabIds) {
            this.withLlamaTerminal(tabId, (inst) => {
              inst.terminal.writeln('');
              inst.terminal.writeln('\x1b[90m[llama-server stopped]\x1b[0m');
            });
          }
        }
      });

    this.electron.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (!this.destroyed) {
        this.applyXtermThemes();
      }
    });

    effect(() => {
      const path = this.workspacePath().trim();
      if (path === this.lastWorkspacePath) {
        return;
      }
      this.lastWorkspacePath = path;
      untracked(() => {
        void this.onWorkspaceRootChanged();
      });
    });

    effect(() => {
      const ex = this.expanded();
      const dock = this.hasDockPanelContent();
      this.ptyTabs();
      this.activeTabId();
      if (!ex || !dock) {
        if (!ex) {
          untracked(() => this.teardownResizeTracking());
        }
        return;
      }
      untracked(() => {
        const path = this.workspacePath().trim();
        if (this.ptyTabs().length === 0 && path) {
          this.addTab();
        }
        void this.ensureActiveTabSession();
        this.queueSafe(() => {
          this.observeActiveHostResize();
          this.applyXtermThemes();
          this.fitActive();
        });
      });
    });

    effect(() => {
      const ids = this.allManagedTabIds();
      const cur = this.activeTabId();
      if (cur && !ids.includes(cur)) {
        untracked(() => this.activeTabId.set(ids[0] ?? null));
      }
    });

    effect(() => {
      this.showLlamaServerTab();
      this.activeLlmModelId();
      this.appConfig();
      untracked(() => this.syncLlamaTabsForActiveModel());
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.endPanelDrag();
    this.teardownResizeTracking();
    this.spawningTabs.clear();
    const sessionIds = this.collectActiveSessionIds();
    for (const sid of sessionIds) {
      void this.electron.workspacePtyKill(sid);
    }
    for (const tabId of [...this.xterms.keys()]) {
      this.disposeXterm(tabId);
    }
  }

  private queueSafe(fn: () => void): void {
    queueMicrotask(() => {
      if (!this.destroyed) {
        fn();
      }
    });
  }

  private collectActiveSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const t of this.ptyTabs()) {
      if (t.sessionId) {
        ids.add(t.sessionId);
      }
    }
    for (const inst of this.xterms.values()) {
      if (inst.sessionId && !inst.sessionId.startsWith(LLAMA_XTERM_SESSION_PREFIX)) {
        ids.add(inst.sessionId);
      }
    }
    return ids;
  }

  private teardownResizeTracking(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeRaf !== 0) {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = 0;
    }
  }

  private endPanelDrag(): void {
    if (!this.panelDragListenersActive) {
      this.panelDrag = null;
      return;
    }
    window.removeEventListener('mousemove', this.boundPanelDragMove);
    window.removeEventListener('mouseup', this.boundPanelDragUp);
    this.panelDragListenersActive = false;
    this.panelDrag = null;
    if (!this.destroyed) {
      this.fitActive();
    }
  }

  toggleExpanded(): void {
    this.expanded.update((v) => !v);
    if (this.expanded()) {
      if (this.ptyTabs().length === 0 && this.hasWorkspace()) {
        this.addTab();
      } else if (this.ptyTabs().length === 0 && this.llamaTabs().length > 0 && !this.hasWorkspace()) {
        this.activeTabId.set(this.llamaTabs()[0]!.id);
      }
    }
  }

  addTab(): void {
    const id = crypto.randomUUID();
    const n = this.ptyTabs().length + 1;
    this.ptyTabs.update((list) => [...list, { id, sessionId: null, title: `Terminal ${n}`, spawnError: undefined }]);
    this.activeTabId.set(id);
    if (this.expanded() && this.hasWorkspace()) {
      this.queueSafe(() => void this.ensureActiveTabSession());
    }
  }

  async closeTab(tabId: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    if (this.isLlamaTabId(tabId)) {
      return;
    }
    const tab = this.ptyTabs().find((t) => t.id === tabId);
    if (tab?.sessionId) {
      await this.electron.workspacePtyKill(tab.sessionId);
    }
    this.disposeXterm(tabId);
    const remaining = this.ptyTabs().filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      if (this.llamaTabs().length > 0) {
        this.ptyTabs.set([]);
        this.activeTabId.set(this.llamaTabs()[0]!.id);
        this.queueSafe(() => {
          this.observeActiveHostResize();
          void this.ensureActiveTabSession();
          this.fitActive();
        });
        return;
      }
      this.teardownResizeTracking();
      this.ptyTabs.set([]);
      this.activeTabId.set(null);
      this.expanded.set(false);
      return;
    }
    this.ptyTabs.set(remaining);
    if (this.activeTabId() === tabId) {
      this.activeTabId.set(remaining[0]?.id ?? null);
    }
    this.queueSafe(() => {
      this.observeActiveHostResize();
      void this.ensureActiveTabSession();
      this.fitActive();
    });
  }

  selectTab(tabId: string): void {
    this.activeTabId.set(tabId);
    this.queueSafe(() => {
      this.observeActiveHostResize();
      void this.ensureActiveTabSession();
      this.fitActive();
      const inst = this.xterms.get(tabId);
      inst?.terminal.focus();
      this.applyXtermThemes();
    });
  }

  /** Clears a failed spawn and tries again (same workspace cwd). */
  retryPtySpawn(tabId: string): void {
    this.ptyTabs.update((list) =>
      list.map((t) => (t.id === tabId ? { ...t, spawnError: undefined } : t)),
    );
    if (this.activeTabId() === tabId) {
      void this.ensureActiveTabSession();
    }
  }

  onResizeHandleDown(ev: MouseEvent): void {
    if (!this.expanded()) {
      return;
    }
    ev.preventDefault();
    this.endPanelDrag();
    this.panelDrag = { startY: ev.clientY, startH: this.panelHeightPx() };
    this.panelDragListenersActive = true;
    window.addEventListener('mousemove', this.boundPanelDragMove);
    window.addEventListener('mouseup', this.boundPanelDragUp);
  }

  private onResizeHandleMove(ev: MouseEvent): void {
    if (this.destroyed) {
      return;
    }
    const drag = this.panelDrag;
    if (!drag) {
      return;
    }
    const delta = drag.startY - ev.clientY;
    const next = Math.min(560, Math.max(120, drag.startH + delta));
    this.panelHeightPx.set(next);
    this.scheduleFit();
  }

  private scheduleFit(): void {
    if (this.destroyed) {
      return;
    }
    if (this.resizeRaf !== 0) {
      cancelAnimationFrame(this.resizeRaf);
    }
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      if (!this.destroyed) {
        this.fitActive();
      }
    });
  }

  private async onWorkspaceRootChanged(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.teardownResizeTracking();
    await this.electron.workspacePtyKillAll();
    if (this.destroyed) {
      return;
    }
    for (const id of [...this.xterms.keys()]) {
      if (!this.isLlamaTabId(id)) {
        this.disposeXterm(id);
      }
    }
    this.ptyTabs.set([]);
    const firstLlamaTabId = this.llamaTabs()[0]?.id ?? null;
    this.activeTabId.set(firstLlamaTabId);
    if (this.expanded() && this.hasWorkspace()) {
      this.addTab();
    }
  }

  private async ensureActiveTabSession(): Promise<void> {
    if (this.destroyed || !this.expanded() || !this.hasDockPanelContent() || !this.electron.isElectron) {
      return;
    }
    this.queueSafe(() => this.mountLlamaXtermsIfNeeded());
    const tabId = this.activeTabId();
    if (!tabId) {
      return;
    }
    if (this.isLlamaTabId(tabId)) {
      return;
    }
    const path = this.workspacePath().trim();
    if (!path) {
      return;
    }
    const tab = this.ptyTabs().find((t) => t.id === tabId);
    if (!tab?.sessionId) {
      if (this.spawningTabs.has(tabId)) {
        return;
      }
      // Do not auto-retry after a failed spawn; require an explicit Retry click. Without this,
      // the effect that watches ``ptyTabs()`` re-fires when ``spawnError`` is written and starts
      // an infinite spawn loop.
      if (tab?.spawnError) {
        return;
      }
      this.spawningTabs.add(tabId);
      this.ptyTabs.update((list) =>
        list.map((t) => (t.id === tabId ? { ...t, spawnError: undefined, spawning: true } : t)),
      );
      const cols = 80;
      const rows = 24;
      try {
        const workspaceRoot = path;
        const cwd = path;
        console.log('[workspace-terminal] spawn requested', { tabId, workspaceRoot, cwd });
        let spawnTimedOut = false;
        const spawnPromise = this.electron.workspacePtySpawn(workspaceRoot, cwd, cols, rows).then((spawnRes) => {
          if (spawnTimedOut && spawnRes.success) {
            void this.electron.workspacePtyKill(spawnRes.sessionId);
          }
          return spawnRes;
        });
        const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
          setTimeout(
            () => {
              spawnTimedOut = true;
              resolve({
                success: false as const,
                error:
                  'Timed out waiting for the main process to start a shell after 10s. ' +
                  'Check the Electron main-process console for [workspace-pty] errors.',
              });
            },
            10_000,
          ),
        );
        const res = await Promise.race([spawnPromise, timeoutPromise]);
        if (this.destroyed) {
          return;
        }
        if (!res.success) {
          const err = 'error' in res ? res.error : 'Could not start shell.';
          console.warn('[workspace-terminal] spawn failed', { tabId, error: err });
          this.ptyTabs.update((list) =>
            list.map((t) => (t.id === tabId ? { ...t, spawnError: err, spawning: false } : t)),
          );
          return;
        }
        console.log('[workspace-terminal] spawn ok', { tabId, sessionId: res.sessionId });
        const still = this.ptyTabs().find((t) => t.id === tabId);
        if (!still || still.sessionId !== null) {
          void this.electron.workspacePtyKill(res.sessionId);
          return;
        }
        this.ptyTabs.update((list) =>
          list.map((t) =>
            t.id === tabId
              ? { ...t, sessionId: res.sessionId, spawnError: undefined, spawning: false }
              : t,
          ),
        );
      } finally {
        this.spawningTabs.delete(tabId);
        this.ptyTabs.update((list) =>
          list.map((t) => (t.id === tabId && t.spawning ? { ...t, spawning: false } : t)),
        );
      }
    }
    if (this.destroyed) {
      return;
    }
    const updated = this.ptyTabs().find((t) => t.id === tabId);
    if (updated?.sessionId) {
      this.queueSafe(() => this.mountPtyXtermIfNeeded(tabId, updated.sessionId!));
    }
  }

  private mountLlamaXtermsIfNeeded(): void {
    if (this.destroyed || this.llamaTabs().length === 0) {
      return;
    }
    for (const tab of this.llamaTabs()) {
      const host = document.getElementById(this.hostDomId(tab.id));
      if (!host || this.xterms.has(tab.id)) {
        continue;
      }
      const terminal = new Terminal({
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
        fontSize: 13,
        theme: buildXtermThemeFromCssVars(getComputedStyle(document.documentElement)),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      this.bindXtermCtrlShiftCopy(terminal);
      terminal.open(host);
      terminal.onData(() => {
        /* read-only log */
      });
      if (this.destroyed) {
        terminal.dispose();
        return;
      }
      this.xterms.set(tab.id, { terminal, fit, sessionId: this.llamaSessionId(tab) });
      fit.fit();
      const backlog = this.llamaBacklogByTab.get(tab.id);
      if (backlog) {
        terminal.write(backlog);
        this.llamaBacklogByTab.delete(tab.id);
      }
    }
  }

  private writeLlamaServerChunk(modelId: string, stream: LlamaServerStreamKind, data: string): void {
    const tabId = this.llamaTabId(modelId, stream);
    const inst = this.xterms.get(tabId);
    if (inst) {
      inst.terminal.write(data);
      return;
    }
    const pending = this.llamaBacklogByTab.get(tabId) ?? '';
    this.llamaBacklogByTab.set(tabId, (pending + data).slice(-WorkspaceTerminalDockComponent.LLAMA_BACKLOG_MAX));
  }

  private mountPtyXtermIfNeeded(tabId: string, sessionId: string): void {
    if (this.destroyed) {
      return;
    }
    const tab = this.ptyTabs().find((t) => t.id === tabId);
    if (!tab || tab.sessionId !== sessionId) {
      return;
    }
    const host = document.getElementById(this.hostDomId(tabId));
    if (!host) {
      console.warn('[workspace-terminal] mount skipped: host element missing', { tabId });
      // Try once more on the next animation frame in case Angular has not flushed yet.
      requestAnimationFrame(() => {
        if (!this.destroyed && !this.xterms.has(tabId)) {
          const retryHost = document.getElementById(this.hostDomId(tabId));
          const retryTab = this.ptyTabs().find((t) => t.id === tabId);
          if (retryHost && retryTab?.sessionId === sessionId) {
            this.mountPtyXtermIfNeeded(tabId, sessionId);
          }
        }
      });
      return;
    }
    if (this.xterms.has(tabId)) {
      return;
    }
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      theme: buildXtermThemeFromCssVars(getComputedStyle(document.documentElement)),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    this.bindXtermCtrlShiftCopy(terminal);
    terminal.open(host);
    terminal.onData((data) => {
      if (this.destroyed) {
        return;
      }
      const live = this.xterms.get(tabId);
      if (!live || live.sessionId !== sessionId) {
        return;
      }
      void this.electron.workspacePtyWrite(sessionId, data);
    });
    if (this.destroyed) {
      terminal.dispose();
      return;
    }
    this.xterms.set(tabId, { terminal, fit, sessionId });
    this.ptySessionToTabId.set(sessionId, tabId);
    try {
      fit.fit();
    } catch {
      /* host may have zero size before layout settles */
    }
    const dims = fit.proposeDimensions();
    if (dims?.cols && dims?.rows) {
      void this.electron.workspacePtyResize(sessionId, dims.cols, dims.rows);
    }
  }

  private disposeXterm(tabId: string): void {
    const inst = this.xterms.get(tabId);
    if (inst) {
      if (inst.sessionId && !inst.sessionId.startsWith(LLAMA_XTERM_SESSION_PREFIX)) {
        this.ptySessionToTabId.delete(inst.sessionId);
      }
      inst.terminal.dispose();
      this.xterms.delete(tabId);
    }
    if (this.isLlamaTabId(tabId)) {
      this.llamaBacklogByTab.delete(tabId);
    }
  }

  private fitActive(): void {
    if (this.destroyed) {
      return;
    }
    const tabId = this.activeTabId();
    if (!tabId) {
      return;
    }
    const inst = this.xterms.get(tabId);
    if (!inst) {
      return;
    }
    try {
      inst.fit.fit();
      const dims = inst.fit.proposeDimensions();
      if (dims?.cols && dims?.rows && !this.isLlamaTabId(tabId)) {
        void this.electron.workspacePtyResize(inst.sessionId, dims.cols, dims.rows);
      }
    } catch {
      /* host may be hidden */
    }
  }

  private applyXtermThemes(): void {
    if (this.destroyed) {
      return;
    }
    const theme = buildXtermThemeFromCssVars(getComputedStyle(document.documentElement));
    for (const inst of this.xterms.values()) {
      inst.terminal.options.theme = theme;
    }
  }

  private observeActiveHostResize(): void {
    if (this.destroyed) {
      return;
    }
    this.resizeObserver?.disconnect();
    const tabId = this.activeTabId();
    if (!tabId) {
      this.resizeObserver = null;
      return;
    }
    const host = document.getElementById(this.hostDomId(tabId));
    if (!host) {
      this.resizeObserver = null;
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.destroyed) {
        this.scheduleFit();
      }
    });
    this.resizeObserver.observe(host);
  }

  private syncLlamaTabsForActiveModel(): void {
    const cfg = this.appConfig();
    const modelId = this.activeLlmModelId();
    if (!cfg || !this.showLlamaServerTab() || !modelId) {
      this.llamaTabs.set([]);
      this.pruneLlamaResources(new Set<string>());
      return;
    }
    const loc = findLlmModelLocation(cfg.llmProviders, modelId);
    const embedCommand = loc?.model.llamaCppManaged?.embeddingRunCommand?.trim() ?? '';
    const streams: LlamaServerStreamKind[] = ['chat'];
    if (embedCommand) {
      streams.push('embed');
    }
    const nextTabs = streams.map((stream) => ({
      id: this.llamaTabId(modelId, stream),
      modelId,
      stream,
      title: stream === 'chat' ? 'llama.cpp chat server' : 'llama.cpp embed server',
    }));
    const activeId = this.activeTabId();
    const nextIds = new Set(nextTabs.map((t) => t.id));
    this.llamaTabs.set(nextTabs);
    this.pruneLlamaResources(nextIds);
    if (activeId && this.isLlamaTabId(activeId) && !nextIds.has(activeId)) {
      this.activeTabId.set(this.ptyTabs()[0]?.id ?? nextTabs[0]?.id ?? null);
    }
  }

  private pruneLlamaResources(activeLlamaTabIds: Set<string>): void {
    for (const tabId of [...this.xterms.keys()]) {
      if (this.isLlamaTabId(tabId) && !activeLlamaTabIds.has(tabId)) {
        this.disposeXterm(tabId);
      }
    }
    for (const tabId of [...this.llamaBacklogByTab.keys()]) {
      if (!activeLlamaTabIds.has(tabId)) {
        this.llamaBacklogByTab.delete(tabId);
      }
    }
  }

  private withLlamaTerminal(tabId: string, fn: (inst: XtermInstance) => void): void {
    const inst = this.xterms.get(tabId);
    if (inst) {
      fn(inst);
    }
  }

  private llamaTabId(modelId: string, stream: LlamaServerStreamKind): string {
    return `${LLAMA_SERVER_TAB_PREFIX}-${modelId}-${stream}`;
  }

  private llamaSessionId(tab: LlamaTerminalTab): string {
    return `${LLAMA_XTERM_SESSION_PREFIX}:${tab.modelId}:${tab.stream}`;
  }

  private isLlamaTabId(tabId: string): boolean {
    return tabId.startsWith(`${LLAMA_SERVER_TAB_PREFIX}-`);
  }

  hostDomId(tabId: string): string {
    return `workspace-term-host-${tabId}`;
  }

  /**
   * Ctrl+Shift+C copies the current selection (terminal-style); does not forward the chord to the PTY.
   */
  private bindXtermCtrlShiftCopy(terminal: Terminal): void {
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') {
        return true;
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) {
        return true;
      }
      if (e.code !== 'KeyC' && e.key !== 'c' && e.key !== 'C') {
        return true;
      }
      e.preventDefault();
      const text = terminal.getSelection();
      if (text) {
        void navigator.clipboard.writeText(text).catch(() => {});
      }
      return false;
    });
  }
}
