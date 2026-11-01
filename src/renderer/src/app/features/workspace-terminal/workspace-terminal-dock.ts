import {
  Component,
  DestroyRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
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
  LspEditorDiagnostic,
} from '@shared/index';
import { findLlmModelLocation, resolveActiveLlmConnection, isRunCommandStreamTag } from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { ThemedConfirmDialogService } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { activeTerminalClosePrompt } from '../../shared/themed-confirm-dialog/format-unsaved-workspace-detail';
import { buildXtermThemeFromCssVars, invalidateTerminalPaletteCache } from './xterm-theme-from-css';
import { consumeOsc7CwdChunk, ptyTabTitleFromCwd } from './terminal-tab-title';
import { EditorProblemsComponent } from '../workspace/editor-problems/editor-problems';

/** Prefix for read-only llama.cpp server log tabs (not PTYs). */
const LLAMA_SERVER_TAB_PREFIX = 'managed-llama-server-tab';
const LLAMA_XTERM_SESSION_PREFIX = 'llama-log';
/** Prefix for read-only agent ``run_command`` output tabs. */
const AGENT_COMMAND_TAB_PREFIX = 'agent-command-tab';
const AGENT_COMMAND_XTERM_SESSION_PREFIX = 'agent-command';
/** Fixed tab id for the unclosable Problems panel. */
export const PROBLEMS_TAB_ID = 'editor-problems-tab';

interface PtyTerminalTab {
  readonly id: string;
  sessionId: string | null;
  title: string;
  /** Last known filesystem cwd for this shell (drives the tab label). */
  cwd?: string;
  /** Set when the main process could not start a PTY for this tab. */
  spawnError?: string;
  /** True while ``workspace-pty-spawn`` is in flight (shows a "starting" placeholder). */
  spawning?: boolean;
  /** True after the shell process exited; relaunch only via Retry. */
  exited?: boolean;
}

interface MergedTab {
  readonly id: string;
  kind: 'pty';
  sessionId: string | null;
  title: string;
  cwd?: string;
}

interface LlamaTerminalTab {
  readonly id: string;
  readonly modelId: string;
  readonly stream: LlamaServerStreamKind;
  readonly title: string;
}

interface AgentCommandTab {
  readonly id: string;
  readonly commandId: string;
  readonly conversationId: string;
  readonly streamTag: string;
  title: string;
  status: 'running' | 'exited' | 'killed';
}

interface XtermInstance {
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  sessionId: string;
}

@Component({
  selector: 'app-workspace-terminal-dock',
  standalone: true,
  imports: [EditorProblemsComponent],
  templateUrl: './workspace-terminal-dock.html',
  styleUrl: './workspace-terminal-dock.css',
  encapsulation: ViewEncapsulation.None,
})
export class WorkspaceTerminalDockComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly themedConfirm = inject(ThemedConfirmDialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly xterms = new Map<string, XtermInstance>();
  /** PTY session id → shell tab id (avoids scanning every chunk). */
  private readonly ptySessionToTabId = new Map<string, string>();
  /** Pending llama bytes keyed by llama tab id until xterm mounts. */
  private readonly llamaBacklogByTab = new Map<string, string>();
  /** Pending run_command bytes keyed by agent tab id until xterm mounts. */
  private readonly agentCommandBacklogByTab = new Map<string, string>();
  /** run_command tabs the user selected themselves (auto-focus on open does not count). */
  private readonly userSelectedAgentCommandTabIds = new Set<string>();
  /** PTY bytes keyed by tab id until xterm mounts. */
  private readonly ptyBacklogByTab = new Map<string, string>();
  /** run_command bytes that arrived before backgroundCommandOpen created the tab. */
  private readonly agentPreOpenBacklog = new Map<string, string>();
  /** Incomplete OSC 7 prefix per PTY session (sequences can split across IPC chunks). */
  private readonly osc7RemainderBySession = new Map<string, string>();
  private readonly spawningTabs = new Set<string>();
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private resizeRaf = 0;
  private panelDrag: { startY: number; startH: number } | null = null;
  private panelDragListenersActive = false;
  private destroyed = false;
  private static readonly LLAMA_BACKLOG_MAX = 400_000;

  private readonly boundPanelDragMove = (e: MouseEvent) => this.onResizeHandleMove(e);
  private readonly boundPanelDragUp = () => this.endPanelDrag();

  readonly workspacePath = input<string>('');
  /** Active chat conversation (session id) for filtering agent command tabs. */
  readonly conversationId = input<string>('');
  /** When the active model uses llama.cpp, show a dedicated llama-server log tab. */
  readonly appConfig = input<AppConfig | null>(null);
  /** LSP diagnostics for the active Monaco editor tab. */
  readonly editorDiagnostics = input<readonly LspEditorDiagnostic[]>([]);
  /** Relative path of the file whose diagnostics are shown. */
  readonly editorDiagnosticsRelativePath = input<string | null>(null);

  readonly revealEditorDiagnostic = output<LspEditorDiagnostic>();

  readonly expanded = signal(false);
  readonly panelResizing = signal(false);
  readonly panelHeightPx = signal(260);
  readonly ptyTabs = signal<PtyTerminalTab[]>([]);
  readonly agentCommandTabs = signal<AgentCommandTab[]>([]);
  readonly llamaTabs = signal<LlamaTerminalTab[]>([]);
  readonly activeTabId = signal<string | null>(null);
  /** Agent command tabs opened while the dock was collapsed (or for another chat), newest last. */
  readonly unseenAgentCommandTabIds = signal<readonly string[]>([]);

  /** Exposed for template bindings. */
  readonly problemsTabId = PROBLEMS_TAB_ID;

  readonly hasWorkspace = computed(() => this.workspacePath().trim().length > 0);

  readonly showLlamaServerTab = computed(() => {
    const c = this.appConfig();
    return !!(c && resolveActiveLlmConnection(c)?.provider === 'llamacpp');
  });

  readonly activeLlmModelId = computed(() => this.appConfig()?.activeLlmModelId?.trim() ?? '');

  readonly agentCommandTabsForConversation = computed(() => {
    const cid = this.conversationId().trim();
    if (!cid) {
      return [];
    }
    return this.agentCommandTabs().filter((t) => t.conversationId === cid);
  });

  /** Unseen agent command tab ids for the active conversation (bar label badge). */
  readonly unseenAgentCommandTabIdsForConversation = computed(() => {
    const visible = new Set(this.agentCommandTabsForConversation().map((t) => t.id));
    return this.unseenAgentCommandTabIds().filter((id) => visible.has(id));
  });

  readonly unseenAgentCommandCount = computed(() => this.unseenAgentCommandTabIdsForConversation().length);

  readonly unseenAgentCommandLabel = computed(() => {
    const n = this.unseenAgentCommandCount();
    return `${n} new ${n === 1 ? 'command' : 'commands'}`;
  });

  readonly hasDockPanelContent = computed(
    () =>
      this.hasWorkspace()
      || this.showLlamaServerTab()
      || this.ptyTabs().length > 0
      || this.agentCommandTabs().length > 0,
  );

  readonly showProblemsTab = computed(() => this.hasWorkspace());

  readonly problemsTabCount = computed(() => (this.editorDiagnostics().length > 0 ? this.editorDiagnostics().length : null));

  /** Shell tabs first; llama tab is rendered separately at the trailing edge (after +). */
  readonly ptyDisplayTabs = computed((): MergedTab[] =>
    this.ptyTabs().map((t) => ({
      id: t.id,
      kind: 'pty' as const,
      sessionId: t.sessionId,
      title: t.title,
      cwd: t.cwd,
    })),
  );

  readonly tabStripCount = computed(() => {
    return (
      this.ptyTabs().length
      + this.agentCommandTabsForConversation().length
      + this.llamaTabs().length
      + (this.showProblemsTab() ? 1 : 0)
    );
  });

  readonly allManagedTabIds = computed((): string[] => {
    const ids: string[] = [];
    if (this.showProblemsTab()) {
      ids.push(PROBLEMS_TAB_ID);
    }
    ids.push(...this.ptyTabs().map((t) => t.id));
    ids.push(...this.agentCommandTabsForConversation().map((t) => t.id));
    ids.push(...this.llamaTabs().map((t) => t.id));
    return ids;
  });

  constructor() {
    this.electron.workspacePtyData$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed) {
        return;
      }
      const osc = consumeOsc7CwdChunk(this.osc7RemainderBySession.get(msg.sessionId) ?? '', msg.data);
      this.osc7RemainderBySession.set(msg.sessionId, osc.remainder);
      if (osc.cwd) {
        this.applyPtyCwdTitle(msg.sessionId, osc.cwd);
      }
      const tabId = this.resolvePtyTabIdForSession(msg.sessionId);
      const inst = tabId ? this.xterms.get(tabId) : undefined;
      if (inst && inst.sessionId === msg.sessionId) {
        inst.terminal.write(msg.data);
        return;
      }
      if (tabId) {
        this.appendCappedBacklog(this.ptyBacklogByTab, tabId, msg.data);
      }
    });

    this.electron.workspacePtyExit$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed) {
        return;
      }
      this.osc7RemainderBySession.delete(msg.sessionId);
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
        inst.sessionId = '';
        this.ptySessionToTabId.delete(msg.sessionId);
        this.ptyBacklogByTab.delete(tabId);
      }
      this.ptyTabs.update((list) =>
        list.map((t) => {
          if (t.sessionId !== msg.sessionId) {
            return t;
          }
          return {
            ...t,
            sessionId: null,
            exited: true,
            title: ptyTabTitleFromCwd(t.cwd ?? t.title.replace(/ \(exited\)$/, ''), true),
          };
        }),
      );
    });

    this.electron.workspacePtyCwd$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed) {
        return;
      }
      this.applyPtyCwdTitle(msg.sessionId, msg.cwd);
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

    this.electron.backgroundCommandOpen$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed) {
        return;
      }
      this.openAgentCommandTab(msg);
    });

    this.electron.toolExecChunk$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed || !isRunCommandStreamTag(msg.streamTag)) {
        return;
      }
      const tab = this.findAgentCommandTabByStreamTag(msg.conversationId, msg.streamTag ?? '');
      if (!tab) {
        this.appendCappedBacklog(
          this.agentPreOpenBacklog,
          this.agentPreOpenKey(msg.conversationId, msg.streamTag ?? ''),
          msg.delta,
        );
        return;
      }
      this.writeAgentCommandChunk(tab.id, msg.delta);
    });

    this.electron.toolExecComplete$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
      if (this.destroyed || !isRunCommandStreamTag(msg.streamTag)) {
        return;
      }
      const tab = this.findAgentCommandTabByStreamTag(msg.conversationId, msg.streamTag ?? '');
      if (!tab) {
        return;
      }
      // A clean exit nobody is looking at needs no tab; failures and kills stay for review.
      if (msg.exitCode === 0 && !this.isAgentCommandTabWatched(tab)) {
        this.dismissAgentCommandTab(tab.id);
        return;
      }
      this.markAgentCommandComplete(tab.id, msg.exitCode ?? null);
    });

    this.electron.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (!this.destroyed) {
        invalidateTerminalPaletteCache();
        this.applyXtermThemes();
      }
    });

    this.themeObserver = new MutationObserver(() => {
      if (!this.destroyed) {
        invalidateTerminalPaletteCache();
        this.applyXtermThemes();
      }
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
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
        this.mountAgentCommandXtermsIfNeeded();
        void this.ensureActiveTabSession();
        this.queueSafe(() => {
          this.observeActiveHostResize();
          this.applyXtermThemes();
          this.fitActive();
        });
      });
    });

    effect(() => {
      // An open dock shows the active chat's command tabs in its strip, so they count as seen.
      if (!this.expanded()) {
        return;
      }
      const seen = this.unseenAgentCommandTabIdsForConversation();
      if (seen.length > 0) {
        untracked(() => this.forgetUnseenAgentCommandTabs(seen));
      }
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
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.endPanelDrag();
    this.teardownResizeTracking();
    this.spawningTabs.clear();
    void this.notifyAllAgentCommandTabsClosed();
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
      if (
        inst.sessionId
        && !inst.sessionId.startsWith(LLAMA_XTERM_SESSION_PREFIX)
        && !inst.sessionId.startsWith(AGENT_COMMAND_XTERM_SESSION_PREFIX)
      ) {
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
    this.panelResizing.set(false);
    if (!this.destroyed) {
      this.fitActive();
    }
  }

  toggleExpanded(): void {
    this.expanded.update((v) => !v);
    if (this.expanded()) {
      const newestUnseen = this.unseenAgentCommandTabIdsForConversation().at(-1);
      if (newestUnseen) {
        if (this.ptyTabs().length === 0 && this.hasWorkspace()) {
          this.addTab();
        }
        this.selectTab(newestUnseen);
      } else if (this.ptyTabs().length === 0 && this.hasWorkspace()) {
        this.addTab();
      } else if (
        this.ptyTabs().length === 0
        && this.agentCommandTabsForConversation().length > 0
      ) {
        this.activeTabId.set(this.agentCommandTabsForConversation()[0]!.id);
      } else if (this.ptyTabs().length === 0 && this.llamaTabs().length > 0 && !this.hasWorkspace()) {
        this.activeTabId.set(this.llamaTabs()[0]!.id);
      }
    }
  }

  openNewTerminal(): void {
    if (!this.hasWorkspace()) {
      return;
    }
    this.addTab();
    this.expanded.set(true);
  }

  addTab(): void {
    const id = crypto.randomUUID();
    const cwd = this.workspacePath().trim();
    this.ptyTabs.update((list) => [
      ...list,
      { id, sessionId: null, title: ptyTabTitleFromCwd(cwd), cwd: cwd || undefined, spawnError: undefined },
    ]);
    this.activeTabId.set(id);
    if (this.expanded() && this.hasWorkspace()) {
      this.queueSafe(() => void this.ensureActiveTabSession());
    }
  }

  async closeTab(tabId: string, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    if (tabId === PROBLEMS_TAB_ID) {
      return;
    }
    if (this.isLlamaTabId(tabId)) {
      return;
    }
    if (this.isAgentCommandTabId(tabId)) {
      const agentTab = this.agentCommandTabs().find((t) => t.id === tabId);
      if (agentTab?.status === 'running') {
        const choice = await this.themedConfirm.open(activeTerminalClosePrompt(agentTab.title));
        if (choice !== 'confirm') {
          return;
        }
      }
      await this.closeAgentCommandTab(tabId);
      return;
    }
    const tab = this.ptyTabs().find((t) => t.id === tabId);
    if (tab?.sessionId) {
      const choice = await this.themedConfirm.open(activeTerminalClosePrompt(tab.title));
      if (choice !== 'confirm') {
        return;
      }
      await this.electron.workspacePtyKill(tab.sessionId);
    }
    this.disposeXterm(tabId);
    const remaining = this.ptyTabs().filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      const agentTabs = this.agentCommandTabsForConversation();
      if (agentTabs.length > 0) {
        this.ptyTabs.set([]);
        this.activeTabId.set(agentTabs[0]!.id);
        this.queueSafe(() => {
          this.observeActiveHostResize();
          this.mountAgentCommandXtermsIfNeeded();
          this.fitActive();
        });
        return;
      }
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
      if (this.hasWorkspace() && this.showProblemsTab()) {
        this.teardownResizeTracking();
        this.ptyTabs.set([]);
        this.activeTabId.set(PROBLEMS_TAB_ID);
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
    if (this.isAgentCommandTabId(tabId)) {
      this.userSelectedAgentCommandTabIds.add(tabId);
    }
    this.queueSafe(() => {
      if (tabId === PROBLEMS_TAB_ID) {
        this.teardownResizeTracking();
        return;
      }
      this.observeActiveHostResize();
      void this.ensureActiveTabSession();
      this.mountAgentCommandXtermsIfNeeded();
      this.fitActive();
      const inst = this.xterms.get(tabId);
      if (inst && !this.isAgentCommandTabId(tabId)) {
        inst.terminal.focus();
      }
      this.applyXtermThemes();
    });
  }

  /** Clears a failed spawn or exited shell and tries again (same workspace cwd). */
  retryPtySpawn(tabId: string): void {
    this.ptyTabs.update((list) =>
      list.map((t) =>
        t.id === tabId ? { ...t, spawnError: undefined, exited: false } : t,
      ),
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
    this.panelResizing.set(true);
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

  /** Kill Python background run_command jobs when their UI tabs are torn down without closeTab. */
  private async notifyAllAgentCommandTabsClosed(): Promise<void> {
    const tabs = this.agentCommandTabs();
    if (tabs.length === 0) {
      return;
    }
    await Promise.all(
      tabs.map((tab) =>
        this.electron.notifyBackgroundCommandTerminalClosed(tab.conversationId, tab.commandId),
      ),
    );
  }

  private applyPtyCwdTitle(sessionId: string, cwd: string): void {
    const nextCwd = cwd.trim();
    if (!nextCwd) {
      return;
    }
    this.ptyTabs.update((list) =>
      list.map((t) => {
        if (t.sessionId !== sessionId) {
          return t;
        }
        return {
          ...t,
          cwd: nextCwd,
          title: ptyTabTitleFromCwd(nextCwd, !!t.exited),
        };
      }),
    );
  }

  private async ensureActiveTabSession(): Promise<void> {
    if (this.destroyed || !this.expanded() || !this.hasDockPanelContent() || !this.electron.isElectron) {
      return;
    }
    this.queueSafe(() => this.mountLlamaXtermsIfNeeded());
    this.queueSafe(() => this.mountAgentCommandXtermsIfNeeded());
    const tabId = this.activeTabId();
    if (!tabId || tabId === PROBLEMS_TAB_ID) {
      return;
    }
    if (this.isLlamaTabId(tabId) || this.isAgentCommandTabId(tabId)) {
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
      // Do not auto-retry after a failed spawn or a natural exit; require Retry / Relaunch.
      if (tab?.spawnError || tab?.exited) {
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
        let spawnTimeoutId: ReturnType<typeof setTimeout> | undefined;
        const spawnPromise = this.electron.workspacePtySpawn(workspaceRoot, cwd, cols, rows).then((spawnRes) => {
          if (spawnTimedOut && spawnRes.success) {
            void this.electron.workspacePtyKill(spawnRes.sessionId);
          }
          return spawnRes;
        });
        const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) => {
          spawnTimeoutId = setTimeout(
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
          );
        });
        const res = await Promise.race([spawnPromise, timeoutPromise]);
        if (spawnTimeoutId !== undefined) {
          clearTimeout(spawnTimeoutId);
        }
        if (this.destroyed) {
          if (res.success) {
            void this.electron.workspacePtyKill(res.sessionId);
          }
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
              ? {
                  ...t,
                  sessionId: res.sessionId,
                  spawnError: undefined,
                  spawning: false,
                  exited: false,
                  cwd: path,
                  title: ptyTabTitleFromCwd(path),
                }
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
      this.queueSafe(() => this.attachOrMountPtyXterm(tabId, updated.sessionId!));
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

  private attachOrMountPtyXterm(tabId: string, sessionId: string): void {
    const existing = this.xterms.get(tabId);
    if (existing) {
      existing.sessionId = sessionId;
      this.ptySessionToTabId.set(sessionId, tabId);
      this.flushPtyBacklog(tabId, existing);
      return;
    }
    this.mountPtyXtermIfNeeded(tabId, sessionId);
  }

  private flushPtyBacklog(tabId: string, inst: XtermInstance): void {
    const backlog = this.ptyBacklogByTab.get(tabId);
    if (backlog) {
      inst.terminal.write(backlog);
      this.ptyBacklogByTab.delete(tabId);
    }
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
      this.attachOrMountPtyXterm(tabId, sessionId);
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
      if (!live?.sessionId) {
        return;
      }
      this.electron.workspacePtyWrite(live.sessionId, data);
    });
    if (this.destroyed) {
      terminal.dispose();
      return;
    }
    const inst = { terminal, fit, sessionId };
    this.xterms.set(tabId, inst);
    this.ptySessionToTabId.set(sessionId, tabId);
    this.flushPtyBacklog(tabId, inst);
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
      if (
        inst.sessionId
        && !inst.sessionId.startsWith(LLAMA_XTERM_SESSION_PREFIX)
        && !inst.sessionId.startsWith(AGENT_COMMAND_XTERM_SESSION_PREFIX)
      ) {
        this.ptySessionToTabId.delete(inst.sessionId);
      }
      inst.terminal.dispose();
      this.xterms.delete(tabId);
    }
    this.ptyBacklogByTab.delete(tabId);
    if (this.isLlamaTabId(tabId)) {
      this.llamaBacklogByTab.delete(tabId);
    }
    if (this.isAgentCommandTabId(tabId)) {
      this.agentCommandBacklogByTab.delete(tabId);
    }
  }

  private fitActive(): void {
    if (this.destroyed) {
      return;
    }
    const tabId = this.activeTabId();
    if (!tabId || tabId === PROBLEMS_TAB_ID) {
      return;
    }
    const inst = this.xterms.get(tabId);
    if (!inst) {
      return;
    }
    try {
      inst.fit.fit();
      const dims = inst.fit.proposeDimensions();
      if (
        dims?.cols
        && dims?.rows
        && inst.sessionId
        && !this.isLlamaTabId(tabId)
        && !this.isAgentCommandTabId(tabId)
      ) {
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

  private isAgentCommandTabId(tabId: string): boolean {
    return tabId.startsWith(`${AGENT_COMMAND_TAB_PREFIX}-`);
  }

  private agentCommandTabId(commandId: string): string {
    return `${AGENT_COMMAND_TAB_PREFIX}-${commandId}`;
  }

  private resolvePtyTabIdForSession(sessionId: string): string | undefined {
    const mapped = this.ptySessionToTabId.get(sessionId);
    if (mapped) {
      return mapped;
    }
    return this.ptyTabs().find((t) => t.sessionId === sessionId)?.id;
  }

  private appendCappedBacklog(store: Map<string, string>, key: string, data: string): void {
    if (!key || !data) {
      return;
    }
    const pending = store.get(key) ?? '';
    store.set(key, (pending + data).slice(-WorkspaceTerminalDockComponent.LLAMA_BACKLOG_MAX));
  }

  private agentPreOpenKey(conversationId: string, streamTag: string): string {
    return `${conversationId.trim()}\0${streamTag.trim()}`;
  }

  private findAgentCommandTabByStreamTag(conversationId: string, streamTag: string): AgentCommandTab | undefined {
    const cid = conversationId.trim();
    const tag = streamTag.trim();
    if (!cid || !tag) {
      return undefined;
    }
    return this.agentCommandTabs().find((t) => t.conversationId === cid && t.streamTag === tag);
  }

  private openAgentCommandTab(msg: {
    conversationId: string;
    commandId: string;
    commandText: string;
    cwdLabel: string;
    label: string;
    streamTag: string;
  }): void {
    const conversationId = msg.conversationId.trim();
    const commandId = msg.commandId.trim();
    if (!conversationId || !commandId) {
      return;
    }
    const tabId = this.agentCommandTabId(commandId);
    const title = (msg.label || commandId).trim() || commandId;
    const existing = this.agentCommandTabs().find((t) => t.id === tabId);
    if (!existing) {
      const streamTag = msg.streamTag.trim() || `run-command:${commandId}`;
      this.agentCommandTabs.update((list) => [
        ...list,
        {
          id: tabId,
          commandId,
          conversationId,
          streamTag,
          title,
          status: 'running',
        },
      ]);
      const preOpenKey = this.agentPreOpenKey(conversationId, streamTag);
      const preOpen = this.agentPreOpenBacklog.get(preOpenKey);
      if (preOpen) {
        this.agentPreOpenBacklog.delete(preOpenKey);
      }
      this.queueSafe(() => {
        this.mountAgentCommandXtermsIfNeeded();
        this.withAgentCommandTerminal(tabId, (inst) => {
          inst.terminal.writeln(`\x1b[90m[run_command ${commandId}]\x1b[0m`);
          inst.terminal.writeln(`\x1b[36m$ ${msg.commandText}\x1b[0m`);
          inst.terminal.writeln(`\x1b[90m(cwd: ${msg.cwdLabel || '.'})\x1b[0m`);
          inst.terminal.writeln('');
          if (preOpen) {
            inst.terminal.write(preOpen);
          }
        });
        if (preOpen && !this.xterms.has(tabId)) {
          this.appendCappedBacklog(this.agentCommandBacklogByTab, tabId, preOpen);
        }
      });
    }
    // Don't pop the dock open: a collapsed dock (or another chat's command) gets a badge instead.
    if (!this.expanded() || this.conversationId().trim() !== conversationId) {
      this.unseenAgentCommandTabIds.update((ids) => [...ids.filter((id) => id !== tabId), tabId]);
      return;
    }
    this.activeTabId.set(tabId);
    this.queueSafe(() => {
      this.observeActiveHostResize();
      this.fitActive();
    });
  }

  private forgetUnseenAgentCommandTabs(tabIds: readonly string[]): void {
    const drop = new Set(tabIds);
    this.unseenAgentCommandTabIds.update((ids) => ids.filter((id) => !drop.has(id)));
  }

  private writeAgentCommandChunk(tabId: string, data: string): void {
    if (!data) {
      return;
    }
    const inst = this.xterms.get(tabId);
    if (inst) {
      inst.terminal.write(data);
      return;
    }
    const pending = this.agentCommandBacklogByTab.get(tabId) ?? '';
    this.agentCommandBacklogByTab.set(
      tabId,
      (pending + data).slice(-WorkspaceTerminalDockComponent.LLAMA_BACKLOG_MAX),
    );
  }

  private markAgentCommandComplete(tabId: string, exitCode: number | null): void {
    const status: AgentCommandTab['status'] = exitCode === null ? 'killed' : 'exited';
    this.agentCommandTabs.update((list) =>
      list.map((t) => {
        if (t.id !== tabId) {
          return t;
        }
        const base = t.title.replace(/ \((exited|killed)\)$/, '');
        return {
          ...t,
          status,
          title: `${base} (${status})`,
        };
      }),
    );
    this.withAgentCommandTerminal(tabId, (inst) => {
      inst.terminal.writeln('');
      if (status === 'killed') {
        inst.terminal.writeln('\x1b[31m[Process killed]\x1b[0m');
      } else {
        inst.terminal.writeln(`\x1b[90m[Exit code ${exitCode}]\x1b[0m`);
      }
    });
  }

  private async closeAgentCommandTab(tabId: string): Promise<void> {
    const tab = this.agentCommandTabs().find((t) => t.id === tabId);
    if (!tab) {
      return;
    }
    await this.electron.notifyBackgroundCommandTerminalClosed(tab.conversationId, tab.commandId);
    const remainingVisible = this.removeAgentCommandTab(tabId);
    if (this.activeTabId() === tabId) {
      this.activeTabId.set(this.fallbackTabIdAfterAgentClose(remainingVisible));
    }
    if (
      this.ptyTabs().length === 0
      && remainingVisible.length === 0
      && this.llamaTabs().length === 0
    ) {
      if (this.hasWorkspace() && this.showProblemsTab()) {
        this.teardownResizeTracking();
        this.activeTabId.set(PROBLEMS_TAB_ID);
        return;
      }
      this.teardownResizeTracking();
      this.expanded.set(false);
      this.activeTabId.set(null);
      return;
    }
    this.queueSafe(() => {
      this.observeActiveHostResize();
      void this.ensureActiveTabSession();
      this.fitActive();
    });
  }

  /**
   * True while the expanded dock shows this tab for the active chat and the user picked it.
   * A tab the agent auto-focused on open is not watched until the user selects it.
   */
  private isAgentCommandTabWatched(tab: AgentCommandTab): boolean {
    return (
      this.expanded()
      && this.activeTabId() === tab.id
      && this.userSelectedAgentCommandTabIds.has(tab.id)
      && this.conversationId().trim() === tab.conversationId
    );
  }

  /**
   * Drops a run_command tab without telling the backend: the job stays tracked so the agent can
   * still read its output, and no "user closed the tab" note is queued for the agent.
   */
  private dismissAgentCommandTab(tabId: string): void {
    const wasActive = this.activeTabId() === tabId;
    const remainingVisible = this.removeAgentCommandTab(tabId);
    if (wasActive) {
      this.activeTabId.set(this.fallbackTabIdAfterAgentClose(remainingVisible));
    }
  }

  /** Disposes a run_command tab's UI state; returns the active chat's remaining command tabs. */
  private removeAgentCommandTab(tabId: string): AgentCommandTab[] {
    this.disposeXterm(tabId);
    this.agentCommandBacklogByTab.delete(tabId);
    this.userSelectedAgentCommandTabIds.delete(tabId);
    this.forgetUnseenAgentCommandTabs([tabId]);
    const remainingAll = this.agentCommandTabs().filter((t) => t.id !== tabId);
    this.agentCommandTabs.set(remainingAll);
    return remainingAll.filter((t) => t.conversationId === this.conversationId().trim());
  }

  private fallbackTabIdAfterAgentClose(remainingVisible: readonly AgentCommandTab[]): string | null {
    return (
      this.ptyTabs()[0]?.id
      ?? remainingVisible[0]?.id
      ?? this.llamaTabs()[0]?.id
      ?? (this.showProblemsTab() ? PROBLEMS_TAB_ID : null)
    );
  }

  private mountAgentCommandXtermsIfNeeded(): void {
    if (this.destroyed) {
      return;
    }
    for (const tab of this.agentCommandTabs()) {
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
      if (this.destroyed) {
        terminal.dispose();
        return;
      }
      this.xterms.set(tab.id, {
        terminal,
        fit,
        sessionId: `${AGENT_COMMAND_XTERM_SESSION_PREFIX}:${tab.commandId}`,
      });
      fit.fit();
      const backlog = this.agentCommandBacklogByTab.get(tab.id);
      if (backlog) {
        terminal.write(backlog);
        this.agentCommandBacklogByTab.delete(tab.id);
      }
    }
  }

  private withAgentCommandTerminal(tabId: string, fn: (inst: XtermInstance) => void): void {
    const inst = this.xterms.get(tabId);
    if (inst) {
      fn(inst);
      return;
    }
    this.mountAgentCommandXtermsIfNeeded();
    const retry = this.xterms.get(tabId);
    if (retry) {
      fn(retry);
    }
  }

  hostDomId(tabId: string): string {
    return `workspace-term-host-${tabId}`;
  }

  isProblemsTabId(tabId: string): boolean {
    return tabId === PROBLEMS_TAB_ID;
  }

  protected onRevealEditorDiagnostic(d: LspEditorDiagnostic): void {
    this.revealEditorDiagnostic.emit(d);
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
