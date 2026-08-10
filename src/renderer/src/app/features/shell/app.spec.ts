import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { lucideAppProviders } from '../../lucide-setup';
import { App } from './app';

type DeleteConfirmHandler = (event: unknown, conversationId: string, payload: unknown) => void;

interface StubRefs {
  /** Captured `onMessageDeleteConfirm` callback so tests can simulate a backend delete-confirm event. */
  deleteConfirmHandler: DeleteConfirmHandler | null;
  /** Captured `onMessageTokenUsage` callback so tests can simulate backend token_usage events. */
  tokenUsageHandler: ((_event: unknown, conversationId: string, usage: unknown) => void) | null;
  saveConversation: Mock;
}

/** Minimal `window.electronAPI` so `App.ngOnInit` does not reject (no real Electron in unit tests). */
function stubElectronApi(): StubRefs {
  const noop = (): void => {};
  const refs: StubRefs = {
    deleteConfirmHandler: null,
    tokenUsageHandler: null,
    saveConversation: vi.fn(async () => noop()),
  };
  const defaultConfig = {
    currentWorkspaceId: null as string | null,
    lastActiveConversationByWorkspaceId: {} as Record<string, string>,
    workspaces: [] as { id: string; name: string; path: string }[],
    themeId: 'woodland',
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
            planRetryAttemptsCount: 2,
          },
        ],
      },
    ],
    audioTranscription: {
      provider: 'openai',
      baseUrl: '',
      model: 'gpt-4o-mini-transcribe',
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
      detectedCaches: [],
    },
  };
  const convMeta = {
    id: 'test-conv',
    title: 'Test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceId: null as string | null,
    customTitle: false,
  };
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    onMessageChunk: noop,
    onMessageToolReadChunk: noop,
    onMessageClearPrimaryStream: noop,
    onMessageDone: noop,
    onMessageTokenUsage: (cb: (_event: unknown, conversationId: string, usage: unknown) => void) => {
      refs.tokenUsageHandler = cb;
    },
    onMessageContextCompressed: noop,
    onMessageStatus: noop,
    onConfigUpdated: noop,
    onSettingsWindowVisibilityChanged: noop,
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
    workspacePtySpawn: async (_workspaceRoot: string, _cwd: string, _cols: number, _rows: number) => ({
      success: false as const,
      error: 'stub',
    }),
    workspacePtyWrite: async () => ({ success: false }),
    workspacePtyResize: async () => ({ success: false }),
    workspacePtyKill: async () => ({ success: false }),
    workspacePtyKillAll: async () => ({ success: true }),
    onReady: noop,
    setAlwaysOnTop: noop,
    loadConfig: async () => ({ ...defaultConfig }),
    saveConfig: async (c: unknown) => c as typeof defaultConfig,
    setLastActiveConversation: async (_workspaceKey: string, _conversationId: string) => ({ ...defaultConfig }),
    patchWorkspaceMonacoScroll: async () => {},
    setActiveLlmModel: async (_modelId: string) => ({ ...defaultConfig }),
    patchHealthMonitor: async (patch: { logLevel?: string; metricsEnabled?: boolean }) => ({
      ...defaultConfig,
      healthMonitor: { ...defaultConfig.healthMonitor, ...patch },
    }),
    getConversations: async () => [convMeta],
    readConversationFromDisk: async () => ({
      ...convMeta,
      messages: [],
      themeId: 'woodland',
    }),
    loadConversation: async () => ({
      ...convMeta,
      messages: [],
      themeId: 'woodland',
    }),
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
    getWorkspaceSystemPromptStatus: async () => ({ hasFile: false, sourceName: '' }),
    pickWorkspaceSystemPrompt: async () => ({
      ok: true as const,
      hasFile: false,
      sourceName: '',
    }),
    getWorkspaceSystemPromptText: async () => ({ ok: true as const, text: '' }),
    saveWorkspaceSystemPromptText: async () => ({
      ok: true as const,
      hasFile: true,
      sourceName: 'system-prompt.md',
    }),
    clearWorkspaceSystemPrompt: async () => ({
      ok: true as const,
      hasFile: false,
      sourceName: '',
    }),
    syncAutoApplyMode: async () => ({ ok: true }),
    startTtsStream: async () => ({ ok: true }),
    registerTtsStreamUrl: async () => ({ url: '' }),
    onTtsStreamPacket: noop,
    abortTtsStream: async () => ({ ok: true }),
    popupFileMenu: async () => {},
    popupHelpMenu: async () => {},
    windowMinimize: noop,
    windowToggleMaximize: noop,
    windowClose: noop,
    windowIsMaximized: async () => false,
    onWindowMaximizedChanged: noop,
    onEditorFindRequested: noop,
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
      providers: [provideNoopAnimations(), ...lucideAppProviders],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the Clara Coder title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Clara Coder');
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
});
