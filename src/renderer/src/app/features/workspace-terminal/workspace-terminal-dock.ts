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
  LlamaServerLifecycleEvent,
  LlamaServerOutputEvent,
  LlamaServerProcessExitEvent,
} from '@shared/index';
import { resolveActiveLlmConnection } from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { buildXtermThemeFromCssVars } from './xterm-theme-from-css';

/** Stable id for the read-only llama.cpp server log tab (not a PTY). */
const LLAMA_SERVER_TAB_ID = 'managed-llama-server-tab';

const LLAMA_XTERM_SESSION = 'llama-log';

interface PtyTerminalTab {
  readonly id: string;
  sessionId: string | null;
  title: string;
}

interface MergedTab {
  readonly id: string;
  kind: 'pty';
  sessionId: string | null;
  title: string;
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
  private readonly spawningTabs = new Set<string>();
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf = 0;
  private panelDrag: { startY: number; startH: number } | null = null;
  private panelDragListenersActive = false;
  private destroyed = false;
  /** If IPC arrives before the llama xterm mounts, hold bytes here and flush after mount. */
  private llamaBacklog = '';
  private static readonly LLAMA_BACKLOG_MAX = 400_000;

  private readonly boundPanelDragMove = (e: MouseEvent) => this.onResizeHandleMove(e);
  private readonly boundPanelDragUp = () => this.endPanelDrag();

  readonly workspacePath = input<string>('');
  /** When the active model uses llama.cpp, show a dedicated llama-server log tab. */
  readonly appConfig = input<AppConfig | null>(null);

  readonly expanded = signal(false);
  readonly panelHeightPx = signal(260);
  readonly ptyTabs = signal<PtyTerminalTab[]>([]);
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
    let n = this.ptyTabs().length;
    if (this.showLlamaServerTab()) {
      n += 1;
    }
    return n;
  });

  readonly allManagedTabIds = computed((): string[] => {
    const ids = this.ptyTabs().map((t) => t.id);
    if (this.showLlamaServerTab()) {
      ids.push(LLAMA_SERVER_TAB_ID);
    }
    return ids;
  });

  protected readonly llamaServerTabId = LLAMA_SERVER_TAB_ID;

  constructor() {
    this.electron.workspacePtyData$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed) {
        return;
      }
      for (const inst of this.xterms.values()) {
        if (inst.sessionId === msg.sessionId) {
          inst.terminal.write(msg.data);
          break;
        }
      }
    });

    this.electron.workspacePtyExit$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed) {
        return;
      }
      for (const [tabId, inst] of [...this.xterms.entries()]) {
        if (inst.sessionId === msg.sessionId) {
          inst.terminal.writeln('');
          inst.terminal.writeln(`\x1b[90m[Exit code ${msg.exitCode}]\x1b[0m`);
          this.disposeXterm(tabId);
          break;
        }
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
      this.writeLlamaServerChunk(msg);
    });

    this.electron.llamaServerProcessExit$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((msg: LlamaServerProcessExitEvent) => {
        if (this.destroyed || msg.modelId !== this.activeLlmModelId()) {
          return;
        }
        const inst = this.xterms.get(LLAMA_SERVER_TAB_ID);
        if (!inst) {
          return;
        }
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

    this.electron.llamaServerLifecycle$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev: LlamaServerLifecycleEvent) => {
        if (this.destroyed || ev.modelId !== this.activeLlmModelId()) {
          return;
        }
        const inst = this.xterms.get(LLAMA_SERVER_TAB_ID);
        if (!inst) {
          return;
        }
        if (ev.phase === 'starting') {
          this.llamaBacklog = '';
          inst.terminal.clear();
          inst.terminal.writeln('\x1b[90m[Starting llama-server…]\x1b[0m');
        } else if (ev.phase === 'stopped') {
          inst.terminal.writeln('');
          inst.terminal.writeln('\x1b[90m[llama-server stopped]\x1b[0m');
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
      if (inst.sessionId && inst.sessionId !== LLAMA_XTERM_SESSION) {
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
      } else if (this.ptyTabs().length === 0 && this.showLlamaServerTab() && !this.hasWorkspace()) {
        this.activeTabId.set(LLAMA_SERVER_TAB_ID);
      }
    }
  }

  addTab(): void {
    const id = crypto.randomUUID();
    const n = this.ptyTabs().length + 1;
    this.ptyTabs.update((list) => [...list, { id, sessionId: null, title: `Terminal ${n}` }]);
    this.activeTabId.set(id);
    if (this.expanded() && this.hasWorkspace()) {
      this.queueSafe(() => void this.ensureActiveTabSession());
    }
  }

  async closeTab(tabId: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    if (tabId === LLAMA_SERVER_TAB_ID) {
      return;
    }
    const tab = this.ptyTabs().find((t) => t.id === tabId);
    if (tab?.sessionId) {
      await this.electron.workspacePtyKill(tab.sessionId);
    }
    this.disposeXterm(tabId);
    const remaining = this.ptyTabs().filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      if (this.showLlamaServerTab()) {
        this.ptyTabs.set([]);
        this.activeTabId.set(LLAMA_SERVER_TAB_ID);
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
      if (id !== LLAMA_SERVER_TAB_ID) {
        this.disposeXterm(id);
      }
    }
    this.ptyTabs.set([]);
    const llama = this.showLlamaServerTab();
    this.activeTabId.set(llama ? LLAMA_SERVER_TAB_ID : null);
    if (this.expanded() && this.hasWorkspace()) {
      this.addTab();
    }
  }

  private async ensureActiveTabSession(): Promise<void> {
    if (this.destroyed || !this.expanded() || !this.hasDockPanelContent() || !this.electron.isElectron) {
      return;
    }
    this.queueSafe(() => this.mountLlamaXtermIfNeeded());
    const tabId = this.activeTabId();
    if (!tabId) {
      return;
    }
    if (tabId === LLAMA_SERVER_TAB_ID) {
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
      this.spawningTabs.add(tabId);
      const cols = 80;
      const rows = 24;
      try {
        const res = await this.electron.workspacePtySpawn(path, cols, rows);
        if (this.destroyed || !res.success) {
          return;
        }
        const still = this.ptyTabs().find((t) => t.id === tabId);
        if (!still || still.sessionId !== null) {
          void this.electron.workspacePtyKill(res.sessionId);
          return;
        }
        this.ptyTabs.update((list) => list.map((t) => (t.id === tabId ? { ...t, sessionId: res.sessionId } : t)));
      } finally {
        this.spawningTabs.delete(tabId);
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

  private mountLlamaXtermIfNeeded(): void {
    if (this.destroyed || !this.showLlamaServerTab()) {
      return;
    }
    const host = document.getElementById(this.hostDomId(LLAMA_SERVER_TAB_ID));
    if (!host || this.xterms.has(LLAMA_SERVER_TAB_ID)) {
      return;
    }
    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
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
    this.xterms.set(LLAMA_SERVER_TAB_ID, { terminal, fit, sessionId: LLAMA_XTERM_SESSION });
    fit.fit();
    if (this.llamaBacklog) {
      terminal.write(this.llamaBacklog);
      this.llamaBacklog = '';
    }
    terminal.focus();
  }

  private writeLlamaServerChunk(msg: LlamaServerOutputEvent): void {
    const data = msg.data;
    const inst = this.xterms.get(LLAMA_SERVER_TAB_ID);
    if (inst) {
      inst.terminal.write(data);
      return;
    }
    this.llamaBacklog = (this.llamaBacklog + data).slice(-WorkspaceTerminalDockComponent.LLAMA_BACKLOG_MAX);
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
    if (!host || this.xterms.has(tabId)) {
      return;
    }
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
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
    fit.fit();
    const dims = fit.proposeDimensions();
    if (dims?.cols && dims?.rows) {
      void this.electron.workspacePtyResize(sessionId, dims.cols, dims.rows);
    }
    terminal.focus();
  }

  private disposeXterm(tabId: string): void {
    const inst = this.xterms.get(tabId);
    if (inst) {
      inst.terminal.dispose();
      this.xterms.delete(tabId);
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
      if (dims?.cols && dims?.rows && tabId !== LLAMA_SERVER_TAB_ID) {
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
