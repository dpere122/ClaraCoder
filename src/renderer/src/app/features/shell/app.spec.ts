import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { lucideAppProviders } from '../../lucide-setup';
import { App } from './app';

/** Minimal `window.electronAPI` so `App.ngOnInit` does not reject (no real Electron in unit tests). */
function stubElectronApi(): void {
  const noop = (): void => {};
  const defaultConfig = {
    currentWorkspaceId: null as string | null,
    workspaces: [] as { id: string; name: string; path: string; themeId?: string }[],
    themeId: 'dark',
    noWorkspaceThemeId: 'dark',
    activeLlmConnectionId: 'default-openai',
    llmConnections: [] as unknown[],
    audioTranscription: {
      provider: 'openai',
      baseUrl: '',
      model: 'gpt-4o-mini-transcribe',
      apiKey: '',
    },
    workspaceTools: {
      editToolsMode: 'standard',
      maxFileReadLines: 400,
      maxSearchResults: 40,
      defaultWorkspaceEncoding: 'utf-8',
      defaultWorkspaceNewline: 'lf',
    },
    healthMonitor: {
      logLevel: 'info',
      metricsEnabled: false,
    },
  };
  const convMeta = {
    id: 'test-conv',
    title: 'Test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceId: null as string | null,
  };
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    onMessageChunk: noop,
    onMessageToolReadChunk: noop,
    onMessageDone: noop,
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
    onReady: noop,
    setAlwaysOnTop: noop,
    loadConfig: async () => ({ ...defaultConfig }),
    getConversations: async () => [convMeta],
    loadConversation: async () => ({
      ...convMeta,
      messages: [],
      themeId: 'dark',
    }),
    saveConversation: async () => noop(),
    setWorkspaceContext: async () => noop(),
    syncAutoApplyMode: async () => ({ ok: true }),
    abortTtsStream: noop,
  };
}

describe('App', () => {
  beforeEach(async () => {
    stubElectronApi();
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

  it('should render the Clara title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Clara AI');
  });

  it('should render the status bar', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('app-status-bar')).not.toBeNull();
  });
});
