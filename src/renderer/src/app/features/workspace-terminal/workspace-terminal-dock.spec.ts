import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed, ComponentFixture, fakeAsync, tick, flush } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import type { AppConfig } from '@shared/index';

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

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => mockFitAddon),
}));

vi.mock('./xterm-theme-from-css', () => ({
  buildXtermThemeFromCssVars: vi.fn(() => ({
    background: '#000',
    foreground: '#fff',
    cursor: '#0f0',
  })),
}));

import { WorkspaceTerminalDockComponent } from './workspace-terminal-dock';
import { ElectronService } from '../../core/electron.service';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { buildXtermThemeFromCssVars } from './xterm-theme-from-css';

describe('WorkspaceTerminalDockComponent', () => {
  let fixture: ComponentFixture<WorkspaceTerminalDockComponent>;
  let component: WorkspaceTerminalDockComponent;
  let mockElectronService: Partial<ElectronService>;
  let workspacePtyDataSubject: Subject<{ sessionId: string; data: string }>;
  let workspacePtyExitSubject: Subject<{ sessionId: string; exitCode: number; signal: number | null }>;
  let configSubject: Subject<AppConfig>;

  beforeEach(async () => {
    vi.clearAllMocks();

    workspacePtyDataSubject = new Subject();
    workspacePtyExitSubject = new Subject();
    configSubject = new Subject();

    mockElectronService = {
      isElectron: true,
      workspacePtyData$: workspacePtyDataSubject.asObservable(),
      workspacePtyExit$: workspacePtyExitSubject.asObservable(),
      llamaServerOutput$: new Subject().asObservable(),
      llamaServerProcessExit$: new Subject().asObservable(),
      llamaServerLifecycle$: new Subject().asObservable(),
      config$: configSubject.asObservable(),
      workspacePtySpawn: vi.fn().mockResolvedValue({ success: true, sessionId: 'test-session-1' }),
      workspacePtyWrite: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyResize: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKill: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKillAll: vi.fn().mockResolvedValue({ success: true }),
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceTerminalDockComponent],
      providers: [
        { provide: ElectronService, useValue: mockElectronService },
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

    it('addTab creates new terminal tab', () => {
      component.addTab();

      expect(component.ptyTabs().length).toBe(1);
      expect(component.ptyTabs()[0].title).toBe('Terminal 1');
    });

    it('addTab increments tab number', () => {
      component.addTab();
      component.addTab();

      expect(component.ptyTabs()[0].title).toBe('Terminal 1');
      expect(component.ptyTabs()[1].title).toBe('Terminal 2');
    });

    it('addTab sets new tab as active', () => {
      component.addTab();

      expect(component.activeTabId()).toBe(component.ptyTabs()[0].id);
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
    });

    it('closeTab kills PTY session', async () => {
      component.addTab();
      const tab = component.ptyTabs()[0];
      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'session-to-kill' } : t))
      );

      await component.closeTab(tab.id);

      expect(mockElectronService.workspacePtyKill).toHaveBeenCalledWith('session-to-kill');
    });

    it('closeTab collapses panel when last tab is closed', async () => {
      component.expanded.set(true);
      component.addTab();
      const tabId = component.ptyTabs()[0].id;

      await component.closeTab(tabId);

      expect(component.expanded()).toBe(false);
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

  describe('PTY data handling', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('writes PTY data to terminal', fakeAsync(() => {
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
      tick();

      expect(mockTerminal.write).toHaveBeenCalledWith('Hello World');
    }));

    it('ignores data for unknown sessions', fakeAsync(() => {
      component.expanded.set(true);
      component.addTab();

      workspacePtyDataSubject.next({ sessionId: 'unknown-session', data: 'Should not appear' });
      tick();

      expect(mockTerminal.write).not.toHaveBeenCalled();
    }));
  });

  describe('PTY exit handling', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('writes exit message to terminal on exit', fakeAsync(() => {
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
      tick();

      expect(mockTerminal.writeln).toHaveBeenCalledWith('');
      expect(mockTerminal.writeln).toHaveBeenCalledWith(expect.stringContaining('Exit code 0'));
    }));

    it('updates tab title to show exited state', fakeAsync(() => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];

      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => (t.id === tab.id ? { ...t, sessionId: 'test-session' } : t))
      );

      workspacePtyExitSubject.next({ sessionId: 'test-session', exitCode: 1, signal: null });
      tick();

      const updatedTab = component.ptyTabs().find((t) => t.id === tab.id);
      expect(updatedTab?.title).toContain('(exited)');
      expect(updatedTab?.sessionId).toBeNull();
    }));
  });

  describe('color support', () => {
    it('uses xterm-256color terminal type', () => {
      expect((Terminal as Mock).mock.calls.length).toBe(0);

      component.expanded.set(true);
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('applies theme from CSS variables', fakeAsync(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      component.expanded.set(true);
      component.addTab();
      tick();

      configSubject.next({} as AppConfig);
      tick();

      expect(buildXtermThemeFromCssVars).toHaveBeenCalled();
    }));

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

    it('selectTab focuses terminal', fakeAsync(() => {
      component.expanded.set(true);
      component.addTab();
      const tab = component.ptyTabs()[0];

      (component as any).xterms.set(tab.id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'test-session',
      });

      component.selectTab(tab.id);
      tick();
      flush();

      expect(mockTerminal.focus).toHaveBeenCalled();
    }));
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

    it('resize notifies PTY of new dimensions', fakeAsync(() => {
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
      tick();

      expect(mockElectronService.workspacePtyResize).toHaveBeenCalledWith('test-session', 120, 40);
    }));
  });

  describe('Ctrl+Shift+C copy handling', () => {
    it('binds custom key event handler on terminal creation', fakeAsync(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      component.expanded.set(true);
      component.addTab();
      tick();

      expect(mockTerminal.attachCustomKeyEventHandler).toHaveBeenCalled();
    }));
  });

  describe('workspace changes', () => {
    it('kills all PTY sessions on workspace change', fakeAsync(() => {
      fixture.componentRef.setInput('workspacePath', '/first/workspace');
      fixture.detectChanges();
      component.expanded.set(true);
      component.addTab();
      tick();

      fixture.componentRef.setInput('workspacePath', '/second/workspace');
      fixture.detectChanges();
      tick();

      expect(mockElectronService.workspacePtyKillAll).toHaveBeenCalled();
    }));

    it('clears tabs on workspace change', fakeAsync(() => {
      fixture.componentRef.setInput('workspacePath', '/first/workspace');
      fixture.detectChanges();
      component.expanded.set(true);
      component.addTab();
      component.addTab();
      tick();

      expect(component.ptyTabs().length).toBe(2);

      fixture.componentRef.setInput('workspacePath', '/second/workspace');
      fixture.detectChanges();
      tick();

      expect(component.ptyTabs().length).toBe(0);
    }));
  });

  describe('spawn error handling', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
    });

    it('displays spawn error in tab', fakeAsync(() => {
      (mockElectronService.workspacePtySpawn as Mock).mockResolvedValue({
        success: false,
        error: 'Could not start shell',
      });

      component.expanded.set(true);
      component.addTab();
      tick();

      const tab = component.ptyTabs()[0];
      expect(tab.spawnError).toBeUndefined();
    }));

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
    it('kills all sessions on destroy', fakeAsync(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      component.expanded.set(true);
      component.addTab();

      (component as any).ptyTabs.update((list: any[]) =>
        list.map((t) => ({ ...t, sessionId: 'active-session' }))
      );

      tick();
      fixture.destroy();

      expect(mockElectronService.workspacePtyKill).toHaveBeenCalledWith('active-session');
    }));

    it('disposes all xterm instances on destroy', fakeAsync(() => {
      fixture.componentRef.setInput('workspacePath', '/test/workspace');
      fixture.detectChanges();
      component.expanded.set(true);
      component.addTab();

      (component as any).xterms.set(component.ptyTabs()[0].id, {
        terminal: mockTerminal,
        fit: mockFitAddon,
        sessionId: 'test-session',
      });

      tick();
      fixture.destroy();

      expect(mockTerminal.dispose).toHaveBeenCalled();
    }));
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
      llamaServerOutput$: new Subject().asObservable(),
      llamaServerProcessExit$: new Subject().asObservable(),
      llamaServerLifecycle$: new Subject().asObservable(),
      config$: new Subject().asObservable(),
      workspacePtySpawn: vi.fn().mockResolvedValue({ success: true, sessionId: 'test-session' }),
      workspacePtyWrite: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyResize: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKill: vi.fn().mockResolvedValue({ success: true }),
      workspacePtyKillAll: vi.fn().mockResolvedValue({ success: true }),
    };

    await TestBed.configureTestingModule({
      imports: [WorkspaceTerminalDockComponent],
      providers: [
        { provide: ElectronService, useValue: mockElectronService },
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

  it('passes basic ANSI colors through to xterm', fakeAsync(() => {
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
    tick();

    expect(mockTerminal.write).toHaveBeenCalledWith(redText);
  }));

  it('passes 256-color sequences through to xterm', fakeAsync(() => {
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
    tick();

    expect(mockTerminal.write).toHaveBeenCalledWith(color256);
  }));

  it('passes true color (24-bit RGB) sequences through to xterm', fakeAsync(() => {
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
    tick();

    expect(mockTerminal.write).toHaveBeenCalledWith(trueColor);
  }));

  it('passes cursor movement sequences through to xterm', fakeAsync(() => {
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
    tick();

    expect(mockTerminal.write).toHaveBeenCalledWith(cursorMove);
  }));
});
