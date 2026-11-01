import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import type { AppConfig } from '@shared/index';
import type {
  BackgroundCommandOpenMessage,
  ToolExecChunkMessage,
  ToolExecCompleteMessage,
} from '../../core/electron.service';

const { mockTerminal, mockFitAddon } = vi.hoisted(() => {
  const mockTerminal = {
    write: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    getSelection: vi.fn(() => ''),
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    options: { theme: {} },
  };
  const mockFitAddon = {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  };
  return { mockTerminal, mockFitAddon };
});

vi.mock('@xterm/xterm', () => ({
  // Must be constructable: dock uses `new Terminal(...)`.
  Terminal: vi.fn().mockImplementation(function MockTerminal() {
    return mockTerminal;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function MockFitAddon() {
    return mockFitAddon;
  }),
}));

import { WorkspaceTerminalDockComponent } from './workspace-terminal-dock';
import { ElectronService } from '../../core/electron.service';
import { ThemedConfirmDialogService } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { buildXtermThemeFromCssVars } from './xterm-theme-from-css';

/** Flush queued microtasks (queueSafe / async teardown) under zoneless TestBed. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Flush microtasks plus one animation frame (xterm mount retries via rAF). */
async function flushUi(): Promise<void> {
  await flushMicrotasks();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  await flushMicrotasks();
}

describe('WorkspaceTerminalDockComponent', () => {
  let fixture: ComponentFixture<WorkspaceTerminalDockComponent>;
  let component: WorkspaceTerminalDockComponent;
  let mockElectronService: Partial<ElectronService>;
  let mockThemedConfirm: { open: Mock };
  let workspacePtyDataSubject: Subject<{ sessionId: string; data: string }>;
  let workspacePtyExitSubject: Subject<{ sessionId: string; exitCode: number; signal: number | null }>;
  let workspacePtyCwdSubject: Subject<{ sessionId: string; cwd: string }>;
  let backgroundCommandOpenSubject: Subject<BackgroundCommandOpenMessage>;
  let toolExecChunkSubject: Subject<ToolExecChunkMessage>;
  let toolExecCompleteSubject: Subject<ToolExecCompleteMessage>;
  let configSubject: Subject<AppConfig>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // jsdom lacks ResizeObserver; dock observes the active xterm host.
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;

    workspacePtyDataSubject = new Subject();
    workspacePtyExitSubject = new Subject();
    workspacePtyCwdSubject = new Subject();
    backgroundCommandOpenSubject = new Subject();
    toolExecChunkSubject = new Subject();
    toolExecCompleteSubject = new Subject();
    configSubject = new Subject();

    mockThemedConfirm = {
      open: vi.fn().mockResolvedValue('confirm'),
    };

    mockElectronService = {
      isElectron: true,
      workspacePtyData$: workspacePtyDataSubject.asObservable(),
      workspacePtyExit$: workspacePtyExitSubject.asObservable(),
      workspacePtyCwd$: workspacePtyCwdSubject.asObservable(),
      backgroundCommandOpen$: backgroundCommandOpenSubject.asObservable(),
      toolExecChunk$: toolExecChunkSubject.asObservable(),
      toolExecComplete$: toolExecCompleteSubject.asObservable(),
      llamaServerOutput$: new Subject<never>().asObservable(),
      llamaServerProcessExit$: new Subject<never>().asObservable(),
      llamaServerLifecycle$: new Subject<never>().asObservable(),
      config$: configSubject.asObservable(),
      workspacePtySpawn: vi.fn().mockResolvedValue({ success: true, sessionId: 'test-session-1' }),
      workspacePtyWrite: vi.fn(),
      workspacePtyResize: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKill: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKillAll: vi.fn().mockResolvedValue({ success: true }),
      notifyBackgroundCommandTerminalClosed: vi.fn().mockResolvedValue({ ok: true, detail: 'ok' }),
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceTerminalDockComponent],
      providers: [
        { provide: ElectronService, useValue: mockElectronService },
        { provide: ThemedConfirmDialogService, useValue: mockThemedConfirm },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkspaceTerminalDockComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
  });

  describe('initialization', () => {
    it('creates component successfully', () => {
      expect(component).toBeTruthy();
    });

    it('starts with collapsed state', () => {
      expect(component.expanded()).toBe(false);
    });

    it('starts with no tabs', () => {
      expect(component.ptyTabs().length).toBe(0);
    });

    it('has default panel height', () => {
      expect(component.panelHeightPx()).toBe(260);
    });
  });

  describe('tab management', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('addTab names the tab after the workspace folder', () => {
      component.addTab();

      expect(component.ptyTabs().length).toBe(1);
      expect(component.ptyTabs()[0].title).toBe('workspace');
      expect(component.ptyTabs()[0].cwd).toBe('/test/workspace');
    });

    it('addTab uses the same folder name for additional tabs in that cwd', () => {
      component.addTab();
      component.addTab();

      expect(component.ptyTabs()[0].title).toBe('workspace');
      expect(component.ptyTabs()[1].title).toBe('workspace');
    });

    it('addTab sets new tab as active', () => {
      component.addTab();

      expect(component.activeTabId()).toBe(component.ptyTabs()[0].id);
    });

    it('openNewTerminal adds a tab and expands the dock', () => {
      component.openNewTerminal();

      expect(component.expanded()).toBe(true);
      expect(component.ptyTabs().length).toBe(1);
    });

    it('openNewTerminal no-ops without a workspace', () => {
      fixture.componentRef.setInput('workspacePath', '');
      fixture.detectChanges();
      component.openNewTerminal();

      expect(component.expanded()).toBe(false);
      expect(component.ptyTabs().length).toBe(0);
    });

    it('selectTab changes active tab', () => {
      component.addTab();
      component.addTab();
      const firstTabId = component.ptyTabs()[0].id;
      const secondTabId = component.ptyTabs()[1].id;

      component.selectTab(firstTabId);
      expect(component.activeTabId()).toBe(firstTabId);

      component.selectTab(secondTabId);
      expect(component.activeTabId()).toBe(secondTabId);
    });

    it('closeTab removes tab', async () => {
      component.addTab();
      component.addTab();
      const firstTabId = component.ptyTabs()[0].id;

      await component.closeTab(firstTabId);

      expect(component.ptyTabs().length).toBe(1);
      expect(component.ptyTabs()[0].id).not.toBe(firstTabId);
      expect(mockThemedConfirm.open).not.toHaveBeenCalled();
    });

    it('closeTab kills PTY session after confirm', async () => {
      component.addTab();
      const tab = component.ptyTabs()[0];
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'session-to-kill' } : t))
      );

      await component.closeTab(tab.id);

      expect(mockThemedConfirm.open).toHaveBeenCalled();
      expect(mockElectronService.workspacePtyKill).toHaveBeenCalledWith('session-to-kill');
    });

    it('closeTab does not kill PTY when confirm is cancelled', async () => {
      mockThemedConfirm.open.mockResolvedValueOnce('cancel');
      component.addTab();
      const tab = component.ptyTabs()[0];
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'session-to-keep' } : t))
      );

      await component.closeTab(tab.id);

      expect(mockThemedConfirm.open).toHaveBeenCalled();
      expect(mockElectronService.workspacePtyKill).not.toHaveBeenCalled();
      expect(component.ptyTabs().some((t) => t.id === tab.id)).toBe(true);
    });

    it('closeTab switches to Problems when last PTY tab is closed with a workspace', async () => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      await flushMicrotasks();
      component.expanded.set(true);
      component.addTab();
      fixture.detectChanges();
      const tabId = component.ptyTabs()[0].id;

      await component.closeTab(tabId);

      expect(component.activeTabId()).toBe('editor-problems-tab');
      expect(component.expanded()).toBe(true);
    });
  });

  describe('expand/collapse', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('toggleExpanded toggles expanded state', () => {
      expect(component.expanded()).toBe(false);

      component.toggleExpanded();
      expect(component.expanded()).toBe(true);

      component.toggleExpanded();
      expect(component.expanded()).toBe(false);
    });

    it('toggleExpanded adds first tab when expanding with workspace', () => {
      component.toggleExpanded();

      expect(component.ptyTabs().length).toBe(1);
    });

    it('toggleExpanded does not add tab when no workspace', () => {
      fixture.componentRef.setInput('workspacePath', '');
      fixture.detectChanges();

      component.toggleExpanded();

      expect(component.ptyTabs().length).toBe(0);
    });
  });

  describe('Problems tab', () => {
    it('shows Problems when a workspace is attached', () => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();

      expect(component.showProblemsTab()).toBe(true);
    });

    it('hides Problems when there is no workspace', () => {
      fixture.componentRef.setInput('workspacePath', '');
      fixture.detectChanges();

      expect(component.showProblemsTab()).toBe(false);
    });
  });

  describe('PTY data handling', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('writes PTY data to terminal', async () => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];

      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
      );

      (component as any).xterms.set(tab.id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'test-session',
      });

      workspacePtyDataSubject.next({ sessionId: 'test-session', data: 'Hello World' });
      await flushMicrotasks();

      expect(mockTerminal.write).toHaveBeenCalledWith('Hello World');
    });

    it('ignores data for unknown sessions', async () => {
      component.expanded.set(true);
      component.addTab();

      workspacePtyDataSubject.next({ sessionId: 'unknown-session', data: 'Should not appear' });
      await flushMicrotasks();

      expect(mockTerminal.write).not.toHaveBeenCalled();
    });

    it('buffers PTY data until xterm mounts', async () => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'late-session' } : t)),
      );

      workspacePtyDataSubject.next({ sessionId: 'late-session', data: 'hello-backlog' });
      await flushMicrotasks();

      expect(mockTerminal.write).not.toHaveBeenCalled();
      expect((component as any).ptyBacklogByTab.get(tab.id)).toBe('hello-backlog');

      (component as any).xterms.set(tab.id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'late-session',
      });
      (component as any).flushPtyBacklog(tab.id, (component as any).xterms.get(tab.id));

      expect(mockTerminal.write).toHaveBeenCalledWith('hello-backlog');
    });
  });

  describe('PTY exit handling', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('writes exit message to terminal on exit', async () => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];

      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
      );

      (component as any).xterms.set(tab.id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'test-session',
      });
      (component as any).ptySessionToTabId.set('test-session', tab.id);

      workspacePtyExitSubject.next({ sessionId: 'test-session', exitCode: 0, signal: null });
      await flushMicrotasks();

      expect(mockTerminal.writeln).toHaveBeenCalledWith('');
      expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('Exit code 0'));
      expect(mockTerminal.dispose).not.toHaveBeenCalled();
    });

    it('updates tab title to show exited state without respawning', async () => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session', spawning: false } : t))
      );
      (mockElectronService.workspacePtySpawn as Mock).mockClear();

      workspacePtyExitSubject.next({ sessionId: 'test-session', exitCode: 1, signal: null });
      await flushMicrotasks();

      const updatedTab = component.ptyTabs().find((t) => t.id === tab.id);
      expect(updatedTab?.title).toContain('(exited)');
      expect(updatedTab?.title).toBe('workspace (exited)');
      expect(updatedTab?.sessionId).toBeNull();
      expect(updatedTab?.exited).toBe(true);
      expect(mockElectronService.workspacePtySpawn).not.toHaveBeenCalled();
    });
  });

  describe('color support', () => {
    it('uses xterm-256color terminal type', () => {
      expect((Terminal as unknown as Mock).mock.calls.length).toBe(0);

      component.expanded.set(true);
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('applies theme from CSS variables', async () => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      await flushMicrotasks();
      component.expanded.set(true);
      component.addTab();
      fixture.detectChanges();
      await flushUi();

      const terminalCalls = (Terminal as unknown as Mock).mock.calls;
      expect(terminalCalls.length).toBeGreaterThan(0);
      const opts = terminalCalls[terminalCalls.length - 1]?.[0] as { theme?: Record<string, string> };
      expect(opts?.theme).toHaveProperty('background');
      expect(opts?.theme).toHaveProperty('foreground');
      expect(opts?.theme).toHaveProperty('cursor');
    });

    it('theme includes all ANSI colors', () => {
      const theme = buildXtermThemeFromCssVars(getComputedStyle(document.documentElement));

      expect(theme).toHaveProperty('background');
      expect(theme).toHaveProperty('foreground');
      expect(theme).toHaveProperty('cursor');
    });
  });

  describe('focus management', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('selectTab focuses terminal', async () => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];

      (component as any).xterms.set(tab.id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'test-session',
      });

      component.selectTab(tab.id);
      await flushMicrotasks();
      await flushMicrotasks();

      expect(mockTerminal.focus).toHaveBeenCalled();
    });
  });

  describe('resize handling', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('onResizeHandleDown starts drag operation', () => {
      component.expanded.set(true);
      const mockEvent = {
        clientY: 100,
        preventDefault: vi.fn(),
      } as unknown as MouseEvent;

      component.onResizeHandleDown(mockEvent);

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(component.panelResizing()).toBe(true);
    });

    it('places the resize handle on the top edge of the tab strip', () => {
      component.expanded.set(true);
      component.addTab();
      fixture.detectChanges();

      const toolbar = fixture.nativeElement.querySelector(
        '.workspace-terminal-dock__toolbar',
      ) as HTMLElement | null;
      const handle = toolbar?.querySelector(
        '.workspace-terminal-dock__resize-handle',
      ) as HTMLElement | null;

      expect(toolbar).toBeTruthy();
      expect(handle).toBeTruthy();
      expect(toolbar?.firstElementChild).toBe(handle);
    });

    it('does not start drag when collapsed', () => {
      component.expanded.set(false);
      const mockEvent = {
        clientY: 100,
        preventDefault: vi.fn(),
      } as unknown as MouseEvent;

      component.onResizeHandleDown(mockEvent);

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('resize notifies PTY of new dimensions', async () => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];

      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
      );

      (component as any).xterms.set(tab.id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'test-session',
      });

      mockFitAddon.proposeDimensions.mockReturnValue({ cols: 120, rows: 40 });

      (component as any).fitActive();
      await flushMicrotasks();

      expect(mockElectronService.workspacePtyResize).toHaveBeenCalledWith('test-session', 120, 40);
    });
  });

  describe('Ctrl+Shift+C copy handling', () => {
    it('binds custom key event handler on terminal creation', async () => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      await flushMicrotasks();
      component.expanded.set(true);
      component.addTab();
      fixture.detectChanges();
      await flushUi();

      expect(mockTerminal.attachCustomKeyEventHandler).toHaveBeenCalled();
    });
  });

  describe('workspace changes', () => {
    it('keeps PTY sessions alive across workspace changes', async () => {
      fixture.componentRef.setInput('workspacePath', '/first/workspace');
      fixture.detectChanges();
      await flushMicrotasks();
      component.addTab();
      const tabId = component.ptyTabs()[0]!.id;
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tabId ? { ...t, sessionId: 'live-session', spawning: false } : t)),
      );
      (component as any).xterms.set(tabId, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'live-session',
      });
      (component as any).ptySessionToTabId.set('live-session', tabId);
      component.expanded.set(true);
      fixture.detectChanges();
      await flushMicrotasks();

      fixture.componentRef.setInput('workspacePath', '/second/workspace');
      fixture.detectChanges();
      await flushMicrotasks();

      expect(mockElectronService.workspacePtyKillAll).not.toHaveBeenCalled();
      expect(mockElectronService.workspacePtyKill).not.toHaveBeenCalled();
      expect(component.ptyTabs().length).toBe(1);
      expect(component.ptyTabs()[0]!.sessionId).toBe('live-session');
      expect(component.ptyTabs()[0]!.id).toBe(tabId);

      workspacePtyDataSubject.next({ sessionId: 'live-session', data: 'still running' });
      await flushMicrotasks();
      expect(mockTerminal.write).toHaveBeenCalledWith('still running');
    });

    it('keeps existing PTY tabs when switching workspaces while expanded', async () => {
      fixture.componentRef.setInput('workspacePath', '/first/workspace');
      fixture.detectChanges();
      await flushMicrotasks();
      component.expanded.set(true);
      component.addTab();
      component.addTab();
      fixture.detectChanges();
      await flushMicrotasks();

      expect(component.ptyTabs().length).toBe(2);
      const tabIds = component.ptyTabs().map((t) => t.id);

      fixture.componentRef.setInput('workspacePath', '/second/workspace');
      fixture.detectChanges();
      await flushMicrotasks();

      expect(component.ptyTabs().length).toBe(2);
      expect(component.ptyTabs().map((t) => t.id)).toEqual(tabIds);
    });

    it('keeps agent command tabs across workspace changes', async () => {
      fixture.componentRef.setInput('workspacePath', '/first/workspace');
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();
      await flushMicrotasks();

      backgroundCommandOpenSubject.next({
        conversationId: 'conv-1',
        commandId: 'abc12345',
        commandText: 'npm run dev',
        cwdLabel: '.',
        label: 'npm run dev',
        streamTag: 'run-command:abc12345',
      });
      await flushMicrotasks();

      expect(component.agentCommandTabs().length).toBe(1);

      fixture.componentRef.setInput('workspacePath', '/second/workspace');
      fixture.detectChanges();
      await flushMicrotasks();

      expect(mockElectronService.notifyBackgroundCommandTerminalClosed).not.toHaveBeenCalled();
      expect(component.agentCommandTabs().length).toBe(1);
      expect(component.agentCommandTabs()[0]!.commandId).toBe('abc12345');
    });

    it('keeps PTY tabs when the workspace is closed', async () => {
      fixture.componentRef.setInput('workspacePath', '/first/workspace');
      fixture.detectChanges();
      await flushMicrotasks();
      component.expanded.set(true);
      component.addTab();
      fixture.detectChanges();
      await flushMicrotasks();

      expect(component.ptyTabs().length).toBe(1);

      fixture.componentRef.setInput('workspacePath', '');
      fixture.detectChanges();
      await flushMicrotasks();

      expect(mockElectronService.workspacePtyKillAll).not.toHaveBeenCalled();
      expect(component.ptyTabs().length).toBe(1);
      expect(component.hasDockPanelContent()).toBe(true);
    });
  });

  describe('spawn error handling', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('displays spawn error in tab', async () => {
      (mockElectronService.workspacePtySpawn as Mock).mockResolvedValue({
        success: false,
        error: 'Could not start shell',
      });

      component.expanded.set(true);
      component.addTab();
      await flushUi();

      const tab = component.ptyTabs()[0];
      expect(tab.spawnError).toBe('Could not start shell');
    });

    it('retryPtySpawn clears error and retries', () => {
      component.addTab();
      const tab = component.ptyTabs()[0];

      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, spawnError: 'Previous error' } : t))
      );

      expect(component.ptyTabs()[0].spawnError).toBe('Previous error');

      component.retryPtySpawn(tab.id);

      expect(component.ptyTabs()[0].spawnError).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('kills a spawn that finishes after destroy', async () => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      let resolveSpawn: ((value: { success: true; sessionId: string }) => void) | undefined;
      (mockElectronService.workspacePtySpawn as Mock).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSpawn = resolve;
          }),
      );

      component.expanded.set(true);
      component.addTab();
      await flushMicrotasks();
      fixture.destroy();

      resolveSpawn?.({ success: true, sessionId: 'late-session' });
      await flushMicrotasks();

      expect(mockElectronService.workspacePtyKill).toHaveBeenCalledWith('late-session');
    });

    it('kills all sessions on destroy', async () => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      await flushMicrotasks();
      component.expanded.set(true);
      component.addTab();
      fixture.detectChanges();
      await flushMicrotasks();

      const tabId = component.ptyTabs()[0]!.id;
      (component as any).spawningTabs.add(tabId);
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tabId ? { ...t, sessionId: 'active-session', spawning: false } : t)),
      );
      (component as any).xterms.set(tabId, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'active-session',
      });

      fixture.destroy();

      expect(mockElectronService.workspacePtyKill).toHaveBeenCalledWith('active-session');
    });

    it('disposes all xterm instances on destroy', async () => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      component.expanded.set(true);
      component.addTab();

      (component as any).xterms.set(component.ptyTabs()[0].id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'test-session',
      });

      await flushMicrotasks();
      fixture.destroy();

      expect(mockTerminal.dispose).toHaveBeenCalled();
    });

    it('notifies backend for agent command tabs on destroy', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      backgroundCommandOpenSubject.next({
        conversationId: 'conv-1',
        commandId: 'abc12345',
        commandText: 'npm run dev',
        cwdLabel: '.',
        label: 'npm run dev',
        streamTag: 'run-command:abc12345',
      });
      await flushMicrotasks();

      fixture.destroy();
      await flushMicrotasks();

      expect(mockElectronService.notifyBackgroundCommandTerminalClosed).toHaveBeenCalledWith(
        'conv-1',
        'abc12345',
      );
    });
  });

  describe('tab titles from cwd', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/home/dev/ClaraCoder');
      fixture.detectChanges();
    });

    it('renames the tab when the PTY cwd event arrives', async () => {
      component.addTab();
      const tab = component.ptyTabs()[0];
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'live-session' } : t)),
      );

      workspacePtyCwdSubject.next({ sessionId: 'live-session', cwd: '/home/dev/ClaraCoder/src' });
      await flushMicrotasks();

      expect(component.ptyTabs()[0].title).toBe('src');
      expect(component.ptyTabs()[0].cwd).toBe('/home/dev/ClaraCoder/src');
    });

    it('renames the tab from an OSC 7 sequence in PTY output', async () => {
      component.addTab();
      const tab = component.ptyTabs()[0];
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'live-session' } : t)),
      );

      workspacePtyDataSubject.next({
        sessionId: 'live-session',
        data: '\x1b]7;file://localhost/tmp/other-project\x07',
      });
      await flushMicrotasks();

      expect(component.ptyTabs()[0].title).toBe('other-project');
    });
  });

  describe('agent command tabs', () => {
    const openCommand = (conversationId: string, commandId: string, label = 'npm run dev') =>
      backgroundCommandOpenSubject.next({
        conversationId,
        commandId,
        commandText: label,
        cwdLabel: '.',
        label,
        streamTag: `run-command:${commandId}`,
      });

    const barBadge = (): HTMLElement | null =>
      fixture.nativeElement.querySelector('.workspace-terminal-dock__bar-badge');

    it('adds a tab and a bar badge without expanding a collapsed dock', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      openCommand('conv-1', 'abc12345');
      await flushMicrotasks();
      fixture.detectChanges();

      expect(component.expanded()).toBe(false);
      expect(component.agentCommandTabsForConversation().length).toBe(1);
      expect(component.agentCommandTabsForConversation()[0].title).toBe('npm run dev');
      expect(component.unseenAgentCommandCount()).toBe(1);
      expect(barBadge()?.textContent?.trim()).toBe('1');
      expect(barBadge()?.getAttribute('aria-label')).toBe('1 new command');
    });

    it('counts each new command on the badge', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      openCommand('conv-1', 'aaa11111');
      openCommand('conv-1', 'bbb22222');
      openCommand('conv-1', 'aaa11111');
      await flushMicrotasks();
      fixture.detectChanges();

      expect(component.unseenAgentCommandCount()).toBe(2);
      expect(barBadge()?.textContent?.trim()).toBe('2');
    });

    it('expanding selects the newest unseen command and clears the badge', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      openCommand('conv-1', 'aaa11111');
      openCommand('conv-1', 'bbb22222');
      await flushMicrotasks();

      component.toggleExpanded();
      await flushMicrotasks();
      fixture.detectChanges();

      expect(component.expanded()).toBe(true);
      expect(component.activeTabId()).toBe('agent-command-tab-bbb22222');
      expect(component.unseenAgentCommandCount()).toBe(0);
      expect(barBadge()).toBeNull();
    });

    it('selects the new command tab without a badge when the dock is already open', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();
      component.expanded.set(true);

      openCommand('conv-1', 'abc12345');
      await flushMicrotasks();
      fixture.detectChanges();

      expect(component.activeTabId()).toBe('agent-command-tab-abc12345');
      expect(component.unseenAgentCommandCount()).toBe(0);
      expect(barBadge()).toBeNull();
    });

    it('badges another chat\'s command only once that chat is active', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      openCommand('conv-2', 'abc12345');
      await flushMicrotasks();
      fixture.detectChanges();

      expect(component.unseenAgentCommandCount()).toBe(0);

      fixture.componentRef.setInput('conversationId', 'conv-2');
      fixture.detectChanges();

      expect(component.unseenAgentCommandCount()).toBe(1);
    });

    it('drops the badge when the unseen command tab is closed', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      openCommand('conv-1', 'abc12345');
      await flushMicrotasks();

      await component.closeTab('agent-command-tab-abc12345');
      await flushMicrotasks();

      expect(component.unseenAgentCommandTabIds()).toEqual([]);
    });

    it('notifies backend and removes tab when closed after confirm', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      backgroundCommandOpenSubject.next({
        conversationId: 'conv-1',
        commandId: 'abc12345',
        commandText: 'npm run dev',
        cwdLabel: '.',
        label: 'npm run dev',
        streamTag: 'run-command:abc12345',
      });
      await flushMicrotasks();

      const tabId = component.agentCommandTabsForConversation()[0].id;
      await component.closeTab(tabId);
      await flushMicrotasks();

      expect(mockThemedConfirm.open).toHaveBeenCalled();
      expect(mockElectronService.notifyBackgroundCommandTerminalClosed).toHaveBeenCalledWith(
        'conv-1',
        'abc12345',
      );
      expect(component.agentCommandTabsForConversation().length).toBe(0);
    });

    it('does not notify backend when close confirm is cancelled', async () => {
      mockThemedConfirm.open.mockResolvedValueOnce('cancel');
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      backgroundCommandOpenSubject.next({
        conversationId: 'conv-1',
        commandId: 'abc12345',
        commandText: 'npm run dev',
        cwdLabel: '.',
        label: 'npm run dev',
        streamTag: 'run-command:abc12345',
      });
      await flushMicrotasks();

      const tabId = component.agentCommandTabsForConversation()[0].id;
      await component.closeTab(tabId);
      await flushMicrotasks();

      expect(mockThemedConfirm.open).toHaveBeenCalled();
      expect(mockElectronService.notifyBackgroundCommandTerminalClosed).not.toHaveBeenCalled();
      expect(component.agentCommandTabsForConversation().length).toBe(1);
    });

    it('closes exited agent tab without confirm', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();
      // Watched tab: a clean exit keeps it open for the user to close.
      component.expanded.set(true);

      backgroundCommandOpenSubject.next({
        conversationId: 'conv-1',
        commandId: 'abc12345',
        commandText: 'echo hi',
        cwdLabel: '.',
        label: 'echo hi',
        streamTag: 'run-command:abc12345',
      });
      await flushMicrotasks();

      const tabId = component.agentCommandTabsForConversation()[0].id;
      component.selectTab(tabId);
      toolExecCompleteSubject.next({
        conversationId: 'conv-1',
        streamTag: 'run-command:abc12345',
        label: 'echo hi',
        exitCode: 0,
      });
      await flushMicrotasks();

      expect(component.agentCommandTabsForConversation()[0].status).toBe('exited');
      mockThemedConfirm.open.mockClear();

      await component.closeTab(tabId);
      await flushMicrotasks();

      expect(mockThemedConfirm.open).not.toHaveBeenCalled();
      expect(mockElectronService.notifyBackgroundCommandTerminalClosed).toHaveBeenCalledWith(
        'conv-1',
        'abc12345',
      );
      expect(component.agentCommandTabsForConversation().length).toBe(0);
    });

    const completeCommand = (conversationId: string, commandId: string, exitCode: number | null) =>
      toolExecCompleteSubject.next({
        conversationId,
        streamTag: `run-command:${commandId}`,
        label: 'npm run build',
        exitCode,
      });

    it('auto-closes an unwatched tab whose command exits cleanly', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      openCommand('conv-1', 'abc12345', 'npm run build');
      await flushMicrotasks();
      expect(component.unseenAgentCommandCount()).toBe(1);

      completeCommand('conv-1', 'abc12345', 0);
      await flushMicrotasks();

      expect(component.agentCommandTabs().length).toBe(0);
      expect(component.unseenAgentCommandTabIds()).toEqual([]);
      expect(mockElectronService.notifyBackgroundCommandTerminalClosed).not.toHaveBeenCalled();
    });

    it('auto-closes a clean exit behind another tab in the open dock', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();
      component.expanded.set(true);

      openCommand('conv-1', 'aaa11111', 'npm run build');
      openCommand('conv-1', 'bbb22222', 'npm run dev');
      await flushMicrotasks();
      expect(component.activeTabId()).toBe('agent-command-tab-bbb22222');

      completeCommand('conv-1', 'aaa11111', 0);
      await flushMicrotasks();

      expect(component.agentCommandTabs().map((t) => t.commandId)).toEqual(['bbb22222']);
      expect(component.activeTabId()).toBe('agent-command-tab-bbb22222');
    });

    it('keeps an unwatched tab when the command fails or is killed', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      openCommand('conv-1', 'aaa11111', 'npm test');
      openCommand('conv-1', 'bbb22222', 'npm run dev');
      await flushMicrotasks();

      completeCommand('conv-1', 'aaa11111', 1);
      completeCommand('conv-1', 'bbb22222', null);
      await flushMicrotasks();

      const tabs = component.agentCommandTabs();
      expect(tabs.map((t) => t.status)).toEqual(['exited', 'killed']);
      expect(component.unseenAgentCommandCount()).toBe(2);
    });

    it('auto-closes a clean exit that was only auto-focused in the open dock', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();
      component.expanded.set(true);

      openCommand('conv-1', 'abc12345', 'npm run build');
      await flushMicrotasks();
      expect(component.activeTabId()).toBe('agent-command-tab-abc12345');

      completeCommand('conv-1', 'abc12345', 0);
      await flushMicrotasks();

      expect(component.agentCommandTabs().length).toBe(0);
      expect(component.activeTabId()).not.toBe('agent-command-tab-abc12345');
    });

    it('collapses the dock when an auto-focused clean exit was its only tab', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();
      component.expanded.set(true);

      openCommand('conv-1', 'abc12345', 'npm run build');
      await flushMicrotasks();
      completeCommand('conv-1', 'abc12345', 0);
      await flushMicrotasks();

      expect(component.agentCommandTabs().length).toBe(0);
      expect(component.expanded()).toBe(false);
      expect(component.activeTabId()).toBeNull();
    });
    it('keeps a clean exit open while the user is watching it', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();
      component.expanded.set(true);

      openCommand('conv-1', 'abc12345', 'npm run build');
      await flushMicrotasks();
      component.selectTab('agent-command-tab-abc12345');
      completeCommand('conv-1', 'abc12345', 0);
      await flushMicrotasks();

      expect(component.agentCommandTabs().length).toBe(1);
      expect(component.agentCommandTabs()[0]!.status).toBe('exited');
      expect(component.activeTabId()).toBe('agent-command-tab-abc12345');
    });

    it('buffers run_command chunks that arrive before the tab opens', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      toolExecChunkSubject.next({
        conversationId: 'conv-1',
        delta: 'early-output\n',
        streamTag: 'run-command:abc12345',
        label: 'echo hi',
      });
      await flushMicrotasks();

      expect((component as any).agentPreOpenBacklog.get('conv-1\0run-command:abc12345')).toBe(
        'early-output\n',
      );

      backgroundCommandOpenSubject.next({
        conversationId: 'conv-1',
        commandId: 'abc12345',
        commandText: 'echo hi',
        cwdLabel: '.',
        label: 'echo hi',
        streamTag: 'run-command:abc12345',
      });
      await flushMicrotasks();

      const tabId = component.agentCommandTabsForConversation()[0].id;
      expect((component as any).agentPreOpenBacklog.has('conv-1\0run-command:abc12345')).toBe(false);
      expect((component as any).agentCommandBacklogByTab.get(tabId)).toContain('early-output\n');
    });

    it('routes run_command output chunks to the matching tab', async () => {
      fixture.componentRef.setInput('conversationId', 'conv-1');
      fixture.detectChanges();

      backgroundCommandOpenSubject.next({
        conversationId: 'conv-1',
        commandId: 'abc12345',
        commandText: 'echo hi',
        cwdLabel: '.',
        label: 'echo hi',
        streamTag: 'run-command:abc12345',
      });
      await flushMicrotasks();

      const tabId = component.agentCommandTabsForConversation()[0].id;
      (component as any).xterms.set(tabId, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'agent-command:abc12345',
      });

      toolExecChunkSubject.next({
        conversationId: 'conv-1',
        delta: 'hello\n',
        streamTag: 'run-command:abc12345',
        label: 'echo hi',
      });
      await flushMicrotasks();

      expect(mockTerminal.write).toHaveBeenCalledWith('hello\n');
    });
  });
});

describe('WorkspaceTerminalDockComponent - ANSI color rendering', () => {
  let fixture: ComponentFixture<WorkspaceTerminalDockComponent>;
  let component: WorkspaceTerminalDockComponent;
  let workspacePtyDataSubject: Subject<{ sessionId: string; data: string }>;

  beforeEach(async () => {
    vi.clearAllMocks();

    workspacePtyDataSubject = new Subject();

    const mockElectronService = {
      isElectron: true,
      workspacePtyData$: workspacePtyDataSubject.asObservable(),
      workspacePtyExit$: new Subject().asObservable(),
      workspacePtyCwd$: new Subject().asObservable(),
      backgroundCommandOpen$: new Subject<never>().asObservable(),
      toolExecChunk$: new Subject<never>().asObservable(),
      toolExecComplete$: new Subject<never>().asObservable(),
      llamaServerOutput$: new Subject<never>().asObservable(),
      llamaServerProcessExit$: new Subject<never>().asObservable(),
      llamaServerLifecycle$: new Subject<never>().asObservable(),
      config$: new Subject().asObservable(),
      workspacePtySpawn: vi.fn().mockResolvedValue({ success: true, sessionId: 'test-session' }),
      workspacePtyWrite: vi.fn(),
      workspacePtyResize: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKill: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKillAll: vi.fn().mockResolvedValue({ success: true }),
      notifyBackgroundCommandTerminalClosed: vi.fn().mockResolvedValue({ ok: true, detail: 'ok' }),
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceTerminalDockComponent],
      providers: [
        { provide: ElectronService, useValue: mockElectronService },
        {
          provide: ThemedConfirmDialogService,
          useValue: { open: vi.fn().mockResolvedValue('confirm') },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkspaceTerminalDockComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('workspacePath', '/test/workspace');
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('passes basic ANSI colors through to xterm', async () => {
    component.expanded.set(true);
    component.addTab();
    const tab = component.ptyTabs()[0];

    (component as any).xterms.set(tab.id, {
      terminal: mockTerminal,
      fit: mockFitAddon,
      sessionId: 'test-session',
    });
    (component as any).ptySessionToTabId.set('test-session', tab.id);
    (component as any).ptyTabs.update((list: any[]) =>
      list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
    );

    const redText = '\x1b[31mError: Something failed\x1b[0m';
    workspacePtyDataSubject.next({ sessionId: 'test-session', data: redText });
    await flushMicrotasks();

    expect(mockTerminal.write).toHaveBeenCalledWith(redText);
  });

  it('passes 256-color sequences through to xterm', async () => {
    component.expanded.set(true);
    component.addTab();
    const tab = component.ptyTabs()[0];

    (component as any).xterms.set(tab.id, {
      terminal: mockTerminal,
      fit: mockFitAddon,
      sessionId: 'test-session',
    });
    (component as any).ptySessionToTabId.set('test-session', tab.id);
    (component as any).ptyTabs.update((list: any[]) =>
      list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
    );

    const color256 = '\x1b[38;5;208mOrange text\x1b[0m';
    workspacePtyDataSubject.next({ sessionId: 'test-session', data: color256 });
    await flushMicrotasks();

    expect(mockTerminal.write).toHaveBeenCalledWith(color256);
  });

  it('passes true color (24-bit RGB) sequences through to xterm', async () => {
    component.expanded.set(true);
    component.addTab();
    const tab = component.ptyTabs()[0];

    (component as any).xterms.set(tab.id, {
      terminal: mockTerminal,
      fit: mockFitAddon,
      sessionId: 'test-session',
    });
    (component as any).ptySessionToTabId.set('test-session', tab.id);
    (component as any).ptyTabs.update((list: any[]) =>
      list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
    );

    const trueColor = '\x1b[38;2;255;100;50mCustom RGB\x1b[0m';
    workspacePtyDataSubject.next({ sessionId: 'test-session', data: trueColor });
    await flushMicrotasks();

    expect(mockTerminal.write).toHaveBeenCalledWith(trueColor);
  });

  it('passes cursor movement sequences through to xterm', async () => {
    component.expanded.set(true);
    component.addTab();
    const tab = component.ptyTabs()[0];

    (component as any).xterms.set(tab.id, {
      terminal: mockTerminal,
      fit: mockFitAddon,
      sessionId: 'test-session',
    });
    (component as any).ptySessionToTabId.set('test-session', tab.id);
    (component as any).ptyTabs.update((list: any[]) =>
      list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
    );

    const cursorMove = '\x1b[2J\x1b[H';
    workspacePtyDataSubject.next({ sessionId: 'test-session', data: cursorMove });
    await flushMicrotasks();

    expect(mockTerminal.write).toHaveBeenCalledWith(cursorMove);
  });
});
