import { importProvidersFrom } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { NgxSpinnerModule } from 'ngx-spinner';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { lucideAppProviders } from '../../lucide-setup';
import { App } from './app';
import { WorkspaceMonacoModelStore } from '../workspace/workspace-monaco/workspace-monaco-model-store';
import {
  CONTEXT_CHAT_BLOCKED_PERCENT,
  estimateTranscriptContextTokens,
} from '../status/context-capacity/context-capacity.utils';

type DeleteConfirmHandler = (event: unknown, conversationId: string, payload: unknown) => void;

interface StubConversationFixture {
  id: string;
  title?: string;
  workspaceId?: string | null;
  messages?: Array<Record<string, unknown>>;
}

interface StubRefs {
  /** Captured `onMessageDeleteConfirm` callback so tests can simulate a backend delete-confirm event. */
  deleteConfirmHandler: DeleteConfirmHandler | null;
  /** Captured `onMessageTokenUsage` callback so tests can simulate backend token_usage events. */
  tokenUsageHandler: ((_event: unknown, conversationId: string, usage: unknown) => void) | null;
  /** Captured `onConfigUpdated` callback so tests can simulate a main-process broadcast. */
  configUpdatedHandler: ((event: unknown, config: unknown) => void) | null;
  saveConversation: Mock;
  saveConfig: Mock;
  patchWorkspaceOpenTabs: Mock;
  loadedConfig: Record<string, unknown>;
}

/** Minimal `window.electronAPI` so `App.ngOnInit` does not reject (no real Electron in unit tests). */
function stubElectronApi(
  fixtures?: StubConversationFixture[],
  configOverrides?: Record<string, unknown>,
): StubRefs {
  const noop = (): void => {};
  const refs: StubRefs = {
    deleteConfirmHandler: null,
    tokenUsageHandler: null,
    configUpdatedHandler: null,
    saveConversation: vi.fn(async () => noop()),
    saveConfig: vi.fn(async (c: unknown) => c),
    patchWorkspaceOpenTabs: vi.fn(async () => undefined),
    loadedConfig: {},
  };
  const defaultConfig = {
    currentWorkspaceId: null as string | null,
    lastActiveConversationByWorkspaceId: {} as Record<string, string>,
    workspaces: [] as { id: string; name: string; path: string }[],
    themeId: 'clara-dark',
    activeLlmModelId: 'default-lmstudio',
    llmProviders: [
      {
        id: 'prov-test',
        name: 'OpenAI',
        provider: 'openai' as const,
        baseUrl: '',
        apiKey: '',
        models: [
          {
            id: 'default-openai',
            name: 'Default',
            model: 'gpt-4o-mini',
            contextWindowTokens: 128_000,
            reasoningEffort: '' as const,
            thinkingMode: 'default' as const,
            samplingPreset: 'provider-default' as const,
            architectureHint: 'auto' as const,
            temperature: 0,
            parallelToolCalls: false,
            optimizationPreset: 'generic' as const,
            maxOutputTokens: 0,
          },
        ],
      },
    ],
    audioTranscription: {
      provider: 'whisper',
      baseUrl: '',
      model: 'small',
      apiKey: '',
      ttsVoice: 'af_heart',
      ttsSpeechSpeed: 1,
    },
    workspaceTools: {
      editToolsMode: 'standard',
      maxFileReadLines: 400,
      maxSearchResults: 40,
      defaultWorkspaceEncoding: 'utf-8',
      defaultWorkspaceNewline: 'lf',
      allowStagingOverlayCommands: false,
      exposeAllWorkspaceFiles: false,
      allowWebAccess: false,
      searxngBaseUrl: '',
      extraUserPath: '',
      enableAgentFormatters: false,
    },
    contextCompression: {
      enabled: true,
      triggerRatio: 0.7,
      targetRatio: 0.55,
      protectTailMessages: 24,
      recentToolBodyMaxChars: 2000,
      oldToolBodyMaxChars: 400,
      systemReserveRatio: 0.25,
    },
    healthMonitor: {
      logLevel: 'info',
      metricsEnabled: false,
    },
    modelManager: {
      customModelsDir: 'C:\\models',
      huggingFaceToken: '',
    },
  };
  const now = new Date().toISOString();
  const conversationFixtures: StubConversationFixture[] = fixtures?.length
    ? fixtures
    : [{ id: 'test-conv', title: 'Test', workspaceId: null, messages: [] }];
  const conversationMetas = conversationFixtures.map((fixture) => ({
    id: fixture.id,
    title: fixture.title ?? fixture.id,
    createdAt: now,
    updatedAt: now,
    workspaceId: fixture.workspaceId ?? null,
    customTitle: false,
  }));
  const conversationById = new Map(
    conversationFixtures.map((fixture, index) => [
      fixture.id,
      {
        ...conversationMetas[index],
        messages: fixture.messages ?? [],
        themeId: 'clara-dark',
      },
    ]),
  );
  const fallbackConv = {
    ...conversationMetas[0],
    messages: conversationFixtures[0]?.messages ?? [],
    themeId: 'clara-dark',
  };
  const loadedConfig = { ...defaultConfig, ...configOverrides };
  refs.loadedConfig = loadedConfig;
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    onMessageChunk: noop,
    onMessageToolReadChunk: noop,
    onMessageClearPrimaryStream: noop,
    onMessagePromotePrimaryToNudge: noop,
    onMessageDone: noop,
    onMessageTokenUsage: (cb: (_event: unknown, conversationId: string, usage: unknown) => void) => {
      refs.tokenUsageHandler = cb;
    },
    onMessageContextCompressed: noop,
    onMessageStatus: noop,
    onConfigUpdated: (cb: (event: unknown, config: unknown) => void) => {
      refs.configUpdatedHandler = cb;
    },
    onSettingsWindowVisibilityChanged: noop,
    onSettingsSelectTab: noop,
    notifySettingsWindowReady: noop,
    onActiveConversationChanged: noop,
    onConversationWorkspaceChanged: noop,
    onWorkspaceChanged: noop,
    onWorkspaceFilesChanged: noop,
    onOpenWorkspace: noop,
    onOpenConversation: noop,
    onScriptOutput: noop,
    onScriptComplete: noop,
    onWorkspacePtyData: noop,
    onWorkspacePtyExit: noop,
    onWorkspacePtyCwd: noop,
    workspacePtySpawn: async (_workspaceRoot: string, _cwd: string, _cols: number, _rows: number) => ({
      success: false as const,
      error: 'stub',
    }),
    workspacePtyWrite: () => {},
    workspacePtyResize: async () => ({ success: false }),
    workspacePtyKill: async () => ({ success: false }),
    workspacePtyKillAll: async () => ({ success: true }),
    onReady: noop,
    setAlwaysOnTop: noop,
    loadConfig: async () => ({ ...loadedConfig }),
    saveConfig: refs.saveConfig,
    modelManagerListCustomModels: async () => ({ ok: true, models: [] }),
    setLastActiveConversation: async (_workspaceKey: string, _conversationId: string) => ({ ...defaultConfig }),
    patchWorkspaceMonacoScroll: async () => {},
    patchWorkspaceOpenTabs: refs.patchWorkspaceOpenTabs,
    setActiveLlmModel: async (_modelId: string) => ({ ...defaultConfig }),
    patchHealthMonitor: async (patch: { logLevel?: string; metricsEnabled?: boolean }) => ({
      ...defaultConfig,
      healthMonitor: { ...defaultConfig.healthMonitor, ...patch },
    }),
    getConversations: async () => conversationMetas,
    readConversationFromDisk: async (id: string) => conversationById.get(id) ?? fallbackConv,
    loadConversation: async (id: string) => conversationById.get(id) ?? fallbackConv,
    saveConversation: refs.saveConversation,
    onMessageDeleteConfirm: (cb: DeleteConfirmHandler) => {
      refs.deleteConfirmHandler = cb;
    },
    maybeAutoTitleConversation: async () => ({ ok: false as const, reason: 'not_due' as const }),
    setWorkspaceContext: async () => noop(),
    listPythonInterpreters: async () => ({
      ok: true as const,
      interpreters: [],
      activeInterpreterId: null as string | null,
    }),
    applyWorkspacePythonInterpreter: async () => ({ ok: true as const }),
    ensureWorkspaceSystemPrompt: async () => ({
      ok: true as const,
      absolutePath: '/tmp/ws/.clara/system-prompt.md',
      relativePath: '.clara/system-prompt.md',
    }),
    syncAutoApplyMode: async () => ({ ok: true }),
    syncAdminElevation: async () => ({ ok: true }),
    startTtsStream: async () => ({ ok: true }),
    registerTtsStreamUrl: async () => ({ url: '' }),
    onTtsStreamPacket: noop,
    abortTtsStream: async () => ({ ok: true }),
    openSettingsWindow: () => {},
    openDocumentation: () => {},
    openHealthWindow: () => {},
    openDependenciesWindow: noop,
    windowMinimize: noop,
    windowToggleMaximize: noop,
    windowClose: noop,
    appQuit: noop,
    windowIsMaximized: async () => false,
    onWindowMaximizedChanged: noop,
    onEditorFindRequested: noop,
    onMenuFileCommand: noop,
    lmStudioListModels: async () => ({ ok: false, error: 'stub' }),
    lmStudioLoadModel: async () => ({ ok: false, error: 'stub' }),
    lmStudioUnloadModel: async () => ({ ok: false, error: 'stub' }),
    setCurrentWorkspace: async () => {},
    getWorkspaceMonacoUnsavedPaths: async () => [],
    reportWorkspaceMonacoUnsavedPaths: noop,
    readWorkspaceFile: async () => ({ ok: false as const, error: 'stub' }),
  };
  return refs;
}

describe('App', () => {
  let refs: StubRefs;

  beforeEach(async () => {
    refs = stubElectronApi();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideNoopAnimations(), importProvidersFrom(NgxSpinnerModule), ...lucideAppProviders],
    }).compileComponents();
  });

  it('restores collapsed chat chrome from config and persists later toggles', async () => {
    refs = stubElectronApi(undefined, {
      chatSidebarCollapsed: true,
      chatExpandedToMainPanel: true,
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const app = fixture.componentInstance as unknown as {
      chatCollapsed: { (): boolean; set: (value: boolean) => void };
      chatExpanded: { (): boolean; set: (value: boolean) => void };
    };
    expect(app.chatCollapsed()).toBe(true);
    expect(app.chatExpanded()).toBe(false);

    refs.saveConfig.mockClear();
    app.chatCollapsed.set(false);
    app.chatExpanded.set(true);
    await fixture.whenStable();

    expect(refs.saveConfig).toHaveBeenCalled();
    const saved = refs.saveConfig.mock.calls.at(-1)?.[0] as {
      chatSidebarCollapsed?: boolean;
      chatExpandedToMainPanel?: boolean;
    };
    expect(saved.chatSidebarCollapsed).toBe(false);
    expect(saved.chatExpandedToMainPanel).toBe(true);
  });

  it('stays on the home screen when defaultHomePageOnStart is set', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      defaultHomePageOnStart: true,
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [{ relativePath: 'src/foo.ts', outsideWorkspace: false }],
          activeTabId: 'file:rel:src/foo.ts',
        },
      },
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();

    const app = fixture.componentInstance as unknown as {
      currentWorkspaceId: () => string | null;
      defaultHomePageOnStart: () => boolean;
      fileTabs: () => Array<{ relativePath?: string }>;
    };
    expect(app.currentWorkspaceId()).toBeNull();
    expect(app.defaultHomePageOnStart()).toBe(true);
    expect(app.fileTabs()).toEqual([]);
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.app-content--no-workspace')).toBeTruthy();
    expect(compiled.querySelector('.main-panel-empty__welcome')).toBeTruthy();
    const checkbox = compiled.querySelector(
      '.main-panel-empty__home-default-checkbox',
    ) as HTMLInputElement | null;
    expect(checkbox?.checked).toBe(true);
  });

  it('persists the default Home page checkbox from the welcome intro', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: null,
      defaultHomePageOnStart: false,
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();

    const checkbox = (fixture.nativeElement as HTMLElement).querySelector(
      '.main-panel-empty__home-default-checkbox',
    ) as HTMLInputElement | null;
    expect(checkbox).toBeTruthy();
    refs.saveConfig.mockClear();
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(refs.saveConfig).toHaveBeenCalled();
    const saved = refs.saveConfig.mock.calls.at(-1)?.[0] as { defaultHomePageOnStart?: boolean };
    expect(saved.defaultHomePageOnStart).toBe(true);
  });

  it('does not restore the last workspace from a config broadcast after a home-on-start launch', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      defaultHomePageOnStart: true,
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const app = fixture.componentInstance as unknown as {
      currentWorkspaceId: () => string | null;
    };
    expect(app.currentWorkspaceId()).toBeNull();

    refs.configUpdatedHandler?.({}, {
      ...refs.loadedConfig,
      currentWorkspaceId: 'ws-a',
      defaultHomePageOnStart: true,
    });
    await fixture.whenStable();
    expect(app.currentWorkspaceId()).toBeNull();
  });

  it('restores open file tabs for the current workspace from config', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [
            { relativePath: 'src/foo.ts', outsideWorkspace: false },
            { relativePath: 'src/bar.ts', outsideWorkspace: false },
          ],
          activeTabId: 'file:rel:src/bar.ts',
        },
      },
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const app = fixture.componentInstance as unknown as {
      fileTabs: () => Array<{ relativePath?: string }>;
      activeMainTabId: () => string | null;
    };
    expect(app.fileTabs().map((t) => t.relativePath)).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(app.activeMainTabId()).toBe('file:rel:src/bar.ts');
  });

  it('restores a persisted editor-grid layout with the focused slot driving fileTabs', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [
            { relativePath: 'src/foo.ts', outsideWorkspace: false },
            { relativePath: 'src/bar.ts', outsideWorkspace: false },
          ],
          activeTabId: 'file:rel:src/bar.ts',
          layout: {
            columns: [
              { slots: [{ tabIds: ['file:rel:src/foo.ts'], activeTabId: 'file:rel:src/foo.ts' }], rowSizes: [1] },
              {
                slots: [{ tabIds: ['file:rel:src/bar.ts', 'file:rel:src/foo.ts'], activeTabId: 'file:rel:src/bar.ts' }],
                rowSizes: [1],
              },
            ],
            columnSizes: [0.5, 0.5],
            focused: [1, 0],
          },
        },
      },
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();

    const app = fixture.componentInstance as unknown as {
      fileTabs: () => Array<{ relativePath?: string }>;
      activeMainTabId: () => string | null;
      allFileTabs: () => Array<{ relativePath?: string }>;
      editorGrid: () => { columns: Array<{ slots: unknown[] }> };
    };
    expect(app.editorGrid().columns).toHaveLength(2);
    // Focused slot is the right column; `fileTabs` reflects only that slot.
    expect(app.fileTabs().map((t) => t.relativePath)).toEqual(['src/bar.ts', 'src/foo.ts']);
    expect(app.activeMainTabId()).toBe('file:rel:src/bar.ts');
    // The same file is open in both slots but appears once in the flat union.
    expect(app.allFileTabs().map((t) => t.relativePath)).toEqual(['src/foo.ts', 'src/bar.ts']);

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelectorAll('app-editor-grid-tab-strip')).toHaveLength(2);
    expect(compiled.querySelectorAll('.editor-grid__gutter--column')).toHaveLength(1);
  });

  it('holds a grid-wide model claim covering every open text tab across slots', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [
            { relativePath: 'src/foo.ts', outsideWorkspace: false },
            { relativePath: 'src/bar.ts', outsideWorkspace: false },
          ],
          activeTabId: 'file:rel:src/bar.ts',
          layout: {
            columns: [
              { slots: [{ tabIds: ['file:rel:src/foo.ts'], activeTabId: 'file:rel:src/foo.ts' }], rowSizes: [1] },
              {
                slots: [{ tabIds: ['file:rel:src/bar.ts', 'file:rel:src/foo.ts'], activeTabId: 'file:rel:src/bar.ts' }],
                rowSizes: [1],
              },
            ],
            columnSizes: [0.5, 0.5],
            focused: [1, 0],
          },
        },
      },
    });
    const store = TestBed.inject(WorkspaceMonacoModelStore);
    const claim = vi.spyOn(store, 'syncGridOpenFiles');
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();

    const last = claim.mock.calls.at(-1)?.[0] ?? [];
    expect(last.map((r) => r.modelKey).sort()).toEqual(['rel:src/bar.ts', 'rel:src/foo.ts']);
  });

  it('renders full file tab names without truncating labels', async () => {
    const longName = 'very-long-workspace-component-name-that-must-stay-visible.ts';
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [
            { relativePath: `src/${longName}`, outsideWorkspace: false },
            { relativePath: 'src/another-quite-long-file-name.spec.ts', outsideWorkspace: false },
          ],
          activeTabId: `file:rel:src/${longName}`,
        },
      },
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const labels = [...compiled.querySelectorAll('.chat-main-tab-label')].map((el) => el.textContent?.trim());
    expect(labels).toEqual([longName, 'another-quite-long-file-name.spec.ts']);
    expect(compiled.querySelector('.chat-area__tab-strip-tabs')).toBeTruthy();
  });

  it('keeps restored open tabs after a stale config-updated broadcast', async () => {
    const workspaces = [
      { id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'ws-b', name: 'B', path: 'C:/tmp/b', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces,
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [{ relativePath: 'src/foo.ts', outsideWorkspace: false }],
          activeTabId: 'file:rel:src/foo.ts',
        },
      },
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const app = fixture.componentInstance as unknown as {
      fileTabs: () => Array<{ relativePath?: string }>;
      currentWorkspaceId: { (): string | null; set: (id: string | null) => void };
    };
    expect(app.fileTabs().map((t) => t.relativePath)).toEqual(['src/foo.ts']);

    refs.configUpdatedHandler?.({}, {
      ...refs.loadedConfig,
      workspaceOpenTabsByWorkspaceId: {},
    });
    await fixture.whenStable();

    app.currentWorkspaceId.set('ws-b');
    await fixture.whenStable();
    expect(app.fileTabs()).toEqual([]);

    app.currentWorkspaceId.set('ws-a');
    await fixture.whenStable();
    expect(app.fileTabs().map((t) => t.relativePath)).toEqual(['src/foo.ts']);
  });

  it('retries open-tab persist after a failed patch', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
      workspaceOpenTabsByWorkspaceId: {
        'ws-a': {
          tabs: [{ relativePath: 'src/foo.ts', outsideWorkspace: false }],
          activeTabId: 'file:rel:src/foo.ts',
        },
      },
    });
    refs.patchWorkspaceOpenTabs.mockRejectedValue(new Error('disk busy'));
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const app = fixture.componentInstance as unknown as {
      openOrFocusFileTab: (relativePath: string) => void;
      currentWorkspaceId: { (): string | null; set: (id: string | null) => void };
    };
    refs.patchWorkspaceOpenTabs.mockClear();
    app.openOrFocusFileTab('src/bar.ts');
    await fixture.whenStable();
    expect(refs.patchWorkspaceOpenTabs).toHaveBeenCalled();

    refs.patchWorkspaceOpenTabs.mockClear();
    refs.patchWorkspaceOpenTabs.mockResolvedValue(undefined);
    app.currentWorkspaceId.set(null);
    await fixture.whenStable();
    expect(refs.patchWorkspaceOpenTabs).toHaveBeenCalled();
    const persisted = refs.patchWorkspaceOpenTabs.mock.calls.at(-1)?.[1] as {
      tabs?: Array<{ relativePath?: string }>;
    };
    expect(persisted?.tabs?.map((t) => t.relativePath)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the Clara Coder app icon in the window chrome', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const icon = compiled.querySelector('.chrome-title-icon') as HTMLImageElement | null;
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('src')).toBe('app-icon.png');
    expect(icon?.getAttribute('alt')).toBe('Clara Coder');
  });

  it('hides workspace-specific chrome when no workspace is open', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.workspace-panel')).toBeNull();
    expect(compiled.querySelector('app-workspace')).toBeNull();
    expect(compiled.querySelector('.sidebar')).toBeNull();
    expect(compiled.querySelector('app-chat-conversation-hub')).toBeNull();
    expect(compiled.querySelector('app-managed-llama-controls')).toBeNull();
    expect(compiled.querySelector('app-workspace-terminal-dock')).toBeNull();
    expect(compiled.querySelector('.chat-area__tab-strip')).toBeNull();
    expect(compiled.querySelector('app-main-panel-empty-state')).toBeTruthy();
    expect(compiled.querySelector('.app-content--no-workspace')).toBeTruthy();
    expect(compiled.querySelector('.chat-area__tab-panel--empty.chat-area__tab-panel--hidden')).toBeNull();
  });

  it('still shows the no-workspace welcome when chat was left expanded', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: null,
      chatSidebarCollapsed: false,
      chatExpandedToMainPanel: true,
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.chat-area__tab-panel--empty.chat-area__tab-panel--hidden')).toBeNull();
    expect(compiled.querySelector('.main-panel-empty__welcome')).toBeTruthy();
    expect(compiled.querySelector('.main-panel-empty__cta')?.textContent).toContain('Add Workspace');
  });

  it('lists recent workspaces on the no-workspace welcome screen', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: null,
      workspaces: [
        { id: 'ws-a', name: 'Alpha', path: 'C:/tmp/alpha', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'ws-b', name: 'Beta', path: 'C:/tmp/beta', createdAt: '2026-02-01T00:00:00.000Z' },
      ],
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const recents = compiled.querySelector('.main-panel-empty__recents');
    expect(recents).toBeTruthy();
    expect(recents?.textContent).toContain('Alpha');
    expect(recents?.textContent).toContain('Beta');
    expect(compiled.querySelector('.main-panel-empty__cta')?.textContent).toContain('Add Workspace');
  });

  it('shows workspace-specific chrome when a workspace is open', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces: [{ id: 'ws-a', name: 'A', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.workspace-panel')).toBeTruthy();
    expect(compiled.querySelector('app-workspace')).toBeTruthy();
    expect(compiled.querySelector('.sidebar')).toBeTruthy();
    expect(compiled.querySelector('app-chat-conversation-hub')).toBeTruthy();
    expect(compiled.querySelector('.app-content--no-workspace')).toBeNull();
  });

  it('persists a delete-confirm for a non-active conversation so it re-surfaces on reopen', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(refs.deleteConfirmHandler).toBeTruthy();

    refs.saveConversation.mockClear();
    refs.deleteConfirmHandler!(null, 'background-conv-id', {
      version: 1,
      requestId: 'req-bg-1',
      relativePath: 'tmp.txt',
      kind: 'file',
      recursive: false,
    });

    // persistArtifactToConversation runs on a background save-chain promise.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(refs.saveConversation).toHaveBeenCalledTimes(1);
    const savedConv = refs.saveConversation.mock.calls[0][0] as { messages: { role: string }[] };
    expect(savedConv.messages.some((m) => m.role === 'delete_confirm')).toBe(true);
  });

  it('does not reset the context meter when a lower token_usage arrives (e.g. llama.cpp checkpoint restore)', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(refs.tokenUsageHandler).toBeTruthy();

    const app = fixture.componentInstance as unknown as {
      contextCapacity: () => { usedTokens: number; measuredFromApi: boolean };
      activeConversationId: () => string | null;
    };
    const convId = app.activeConversationId() ?? 'test-conv';

    // First measurement anchors the meter to the API reading.
    refs.tokenUsageHandler!({}, convId, { inputTokens: 100_000 });
    await fixture.whenStable();
    expect(app.contextCapacity().usedTokens).toBe(100_000);
    expect(app.contextCapacity().measuredFromApi).toBe(true);

    // A later, lower measurement (server silently truncated context via a checkpoint restore)
    // must NOT lower the meter — only an explicit contextCompressed event may do that.
    refs.tokenUsageHandler!({}, convId, { inputTokens: 20_000 });
    await fixture.whenStable();
    expect(app.contextCapacity().usedTokens).toBe(100_000);

    // A higher measurement still raises the meter (monotonic increase).
    refs.tokenUsageHandler!({}, convId, { inputTokens: 120_000 });
    await fixture.whenStable();
    expect(app.contextCapacity().usedTokens).toBe(120_000);
  });

  it('does not lock the composer when switching away and back to a chat with leftover context', async () => {
    const fatToolBody = 'x'.repeat(500_000);
    refs = stubElectronApi([
      {
        id: 'conv-fat',
        title: 'Fat',
        messages: [
          {
            role: 'chain',
            label: 'read',
            text: fatToolBody,
            state: 'complete',
            source: 'tool',
            statusId: 'read-1',
          },
        ],
      },
      { id: 'conv-other', title: 'Other', messages: [] },
    ]);

    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(refs.tokenUsageHandler).toBeTruthy();

    const app = fixture.componentInstance as unknown as {
      contextCapacity: () => {
        usedTokens: number;
        usedPercentage: number;
        measuredFromApi: boolean;
      };
      contextChatBlocked: () => boolean;
      activeConversationId: () => string | null;
      onSelectConversation: (id: string) => Promise<void>;
    };

    expect(app.activeConversationId()).toBe('conv-fat');
    const heuristicTokens = estimateTranscriptContextTokens({
      messages: [
        {
          role: 'chain',
          label: 'read',
          text: fatToolBody,
          state: 'complete',
          source: 'tool',
          statusId: 'read-1',
        },
      ],
      streamingParts: [],
      workspaceContextText: '',
    });
    expect((heuristicTokens / 128_000) * 100).toBeGreaterThanOrEqual(CONTEXT_CHAT_BLOCKED_PERCENT);

    refs.tokenUsageHandler!({}, 'conv-fat', { inputTokens: 64_000 });
    await fixture.whenStable();
    expect(app.contextCapacity().usedTokens).toBe(64_000);
    expect(app.contextCapacity().measuredFromApi).toBe(true);
    expect(app.contextChatBlocked()).toBe(false);

    await app.onSelectConversation('conv-other');
    await fixture.whenStable();
    expect(app.activeConversationId()).toBe('conv-other');

    await app.onSelectConversation('conv-fat');
    await fixture.whenStable();
    expect(app.activeConversationId()).toBe('conv-fat');
    expect(app.contextCapacity().usedTokens).toBe(64_000);
    expect(app.contextCapacity().measuredFromApi).toBe(true);
    expect(app.contextChatBlocked()).toBe(false);
  });

  function fakeChromeMenuEvent(rect: Partial<DOMRect> = {}): MouseEvent {
    const el = document.createElement('button');
    el.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 5,
        left: 10,
        right: 50,
        top: 5,
        bottom: 25,
        width: 40,
        height: 20,
        toJSON: () => ({}),
        ...rect,
      }) as DOMRect;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'currentTarget', { value: el });
    return ev;
  }

  it('opens and toggles the titlebar File menu', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const app = fixture.componentInstance as unknown as {
      onChromeFileMenu: (ev: MouseEvent) => void;
      chromeMenu: () => string | null;
    };
    app.onChromeFileMenu(fakeChromeMenuEvent());
    expect(app.chromeMenu()).toBe('file');
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const items = [...compiled.querySelectorAll('.chrome-dropdown-menu-item')] as HTMLButtonElement[];
    const newAgent = items.find((el) => el.textContent?.includes('New Agent'));
    const closeWorkspace = items.find((el) => el.textContent?.includes('Close Workspace'));
    expect(newAgent?.disabled).toBe(true);
    expect(closeWorkspace).toBeTruthy();
    expect(closeWorkspace?.disabled).toBe(true);
    app.onChromeFileMenu(fakeChromeMenuEvent());
    expect(app.chromeMenu()).toBeNull();
  });

  it('keeps Open Recent open while the pointer is on the flyout', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const app = fixture.componentInstance as unknown as {
      onChromeFileMenu: (ev: MouseEvent) => void;
      onChromeOpenRecentEnter: (ev: MouseEvent) => void;
      onChromeRecentSubmenuEnter: () => void;
      onChromeFileItemEnter: () => void;
      chromeMenu: () => string | null;
      chromeRecentMenuX: () => number;
    };
    app.onChromeFileMenu(fakeChromeMenuEvent());
    app.onChromeOpenRecentEnter(fakeChromeMenuEvent({ left: 10, right: 80, top: 40, bottom: 60 }));
    expect(app.chromeMenu()).toBe('file-recent');
    expect(app.chromeRecentMenuX()).toBe(79);
    app.onChromeFileItemEnter();
    app.onChromeRecentSubmenuEnter();
    expect(app.chromeMenu()).toBe('file-recent');
  });

  it('routes native File menu commands and ignores create actions without a workspace', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const beginCreateFromMenu = vi.fn();
    const openNewTerminal = vi.fn();
    const onNewConversation = vi.fn();
    const appQuit = vi.fn();
    const app = fixture.componentInstance as unknown as {
      onMenuFileCommand: (command: { action: string; workspaceId?: string }) => void;
      onNewConversation: typeof onNewConversation;
      workspacePanel: { beginCreateFromMenu: typeof beginCreateFromMenu } | undefined;
      workspaceTerminalDock: { openNewTerminal: typeof openNewTerminal } | undefined;
      electron: { appQuit: () => void };
      currentWorkspaceId: { (): string | null; set: (id: string | null) => void };
    };
    app.workspacePanel = { beginCreateFromMenu };
    app.workspaceTerminalDock = { openNewTerminal };
    app.onNewConversation = onNewConversation;
    app.electron.appQuit = appQuit;

    app.onMenuFileCommand({ action: 'new-file' });
    app.onMenuFileCommand({ action: 'new-folder' });
    app.onMenuFileCommand({ action: 'new-agent' });
    app.onMenuFileCommand({ action: 'new-terminal' });
    app.onMenuFileCommand({ action: 'close-workspace' });
    expect(beginCreateFromMenu).not.toHaveBeenCalled();
    expect(onNewConversation).not.toHaveBeenCalled();
    expect(openNewTerminal).not.toHaveBeenCalled();

    app.currentWorkspaceId.set('ws-a');
    app.onMenuFileCommand({ action: 'new-file' });
    app.onMenuFileCommand({ action: 'new-folder' });
    app.onMenuFileCommand({ action: 'new-agent' });
    app.onMenuFileCommand({ action: 'new-terminal' });
    expect(beginCreateFromMenu).toHaveBeenCalledWith('file');
    expect(beginCreateFromMenu).toHaveBeenCalledWith('folder');
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(openNewTerminal).toHaveBeenCalledTimes(1);

    app.onMenuFileCommand({ action: 'exit' });
    expect(appQuit).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation before File → Close Workspace and then shows the welcome screen', async () => {
    refs = stubElectronApi(undefined, {
      currentWorkspaceId: 'ws-a',
      workspaces: [{ id: 'ws-a', name: 'Alpha', path: 'C:/tmp/a', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const app = fixture.componentInstance as unknown as {
      closeCurrentWorkspace: () => Promise<void>;
      themedConfirm: { open: (opts: unknown) => Promise<string> };
      currentWorkspaceId: { (): string | null };
    };
    const open = vi.fn(async () => 'cancel');
    app.themedConfirm.open = open;

    await app.closeCurrentWorkspace();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Close workspace',
        confirmText: 'Close workspace',
        message: expect.stringContaining('Alpha'),
      }),
    );
    expect(app.currentWorkspaceId()).toBe('ws-a');

    open.mockResolvedValue('confirm');
    await app.closeCurrentWorkspace();
    fixture.detectChanges();
    expect(app.currentWorkspaceId()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.app-content--no-workspace')).toBeTruthy();
  });
});
