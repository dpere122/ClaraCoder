import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  Conversation,
  ConversationMeta,
  LlamaServerLifecycleEvent,
  LlamaServerProcessExitEvent,
} from '@shared/index';
import { PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID, SecretValue } from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { ConversationSessionService } from './conversation-session.service';
import { STALE_HITL_SUMMARY } from './abandon-stale-hitl';

function localLlamaConfig(modelId = 'local-model'): AppConfig {
  return {
    activeLlmModelId: modelId,
    llmProviders: [
      {
        id: PINNED_LLAMA_CPP_LOCAL_PROVIDER_ID,
        name: 'Local llama.cpp',
        provider: 'llamacpp',
        baseUrl: '',
        apiKey: SecretValue.of(''),
        models: [
          {
            id: modelId,
            name: 'Local',
            model: 'local',
            contextWindowTokens: 8192,
            thinkingMode: 'default',
            samplingPreset: 'provider-default',
            architectureHint: 'auto',
            temperature: 0,
            parallelToolCalls: false,
            optimizationPreset: 'generic',
            maxOutputTokens: 0,
            llamaCppManaged: { chatRunCommand: 'llama-server --port {{PORT}}', embeddingRunCommand: '' },
          },
        ],
      },
    ],
  } as unknown as AppConfig;
}

function mockElectron(overrides: Partial<{
  loadConversation: ElectronService['loadConversation'];
  saveConversation: ReturnType<typeof vi.fn>;
  newConversation: ElectronService['newConversation'];
  readConversationFromDisk: ElectronService['readConversationFromDisk'];
  getConversations: ElectronService['getConversations'];
}> = {}) {
  const doneSubject = new Subject<{ conversationId: string; outcome: 'completed' | 'aborted' | 'error' }>();
  const configSubject = new Subject<AppConfig>();
  const llamaServerLifecycleSubject = new Subject<LlamaServerLifecycleEvent>();
  const llamaServerProcessExitSubject = new Subject<LlamaServerProcessExitEvent>();
  const abortMessage = vi.fn(async () => ({ ok: true }));
  const saveConversation = overrides.saveConversation ?? vi.fn(async () => undefined);
  const convMeta: ConversationMeta = {
    id: 'test-conv',
    title: 'Test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceId: 'ws-1',
    customTitle: false,
  };
  const electron = {
    chunk$: new Subject().asObservable(),
    toolReadChunk$: new Subject().asObservable(),
    toolExecChunk$: new Subject().asObservable(),
    toolExecComplete$: new Subject().asObservable(),
    fileJournal$: new Subject().asObservable(),
    appendConversationFileJournal: vi.fn(async () => ({ ok: true })),
    restoreConversationTimeline: vi.fn(async () => ({ ok: false, error: 'not mocked' })),
    listConversationFileJournal: vi.fn(async () => []),
    diff$: new Subject().asObservable(),
    stagedTransferBatch$: new Subject().asObservable(),
    acceptCommand$: new Subject().asObservable(),
    copyConfirm$: new Subject().asObservable(),
    deleteConfirm$: new Subject().asObservable(),
    plannerProgress$: new Subject().asObservable(),
    planConfirm$: new Subject().asObservable(),
    agentQuestion$: new Subject().asObservable(),
    themeProposal$: new Subject().asObservable(),
    llmStatus$: new Subject().asObservable(),
    finalText$: new Subject().asObservable(),
    clearPrimaryStream$: new Subject().asObservable(),
    promotePrimaryToNudge$: new Subject().asObservable(),
    done$: doneSubject.asObservable(),
    config$: configSubject.asObservable(),
    llamaServerLifecycle$: llamaServerLifecycleSubject.asObservable(),
    llamaServerProcessExit$: llamaServerProcessExitSubject.asObservable(),
    loadConversation:
      overrides.loadConversation ??
      (async () =>
        ({
          ...convMeta,
          messages: [
            { role: 'user', text: 'hi' },
            {
              role: 'diff',
              payload: {
                version: 1,
                relativePath: 'a.ts',
                rows: [],
                language: 'typescript',
                fullNewContent: '',
                truncated: false,
              },
              reviewStatus: 'pending',
            },
          ],
          themeId: 'clara-dark',
        }) satisfies Conversation),
    newConversation:
      overrides.newConversation ??
      (async () => ({
        ...convMeta,
        id: 'conv-b',
        messages: [],
        themeId: 'clara-dark',
      }) satisfies Conversation),
    loadConfig: async () => ({
      currentWorkspaceId: 'ws-1',
      workspaces: [],
      themeId: 'clara-dark',
      activeLlmModelId: 'default',
      llmProviders: [],
      lastActiveConversationByWorkspaceId: {},
    }),
    setLastActiveConversation: async () => ({}),
    saveConversation,
    readConversationFromDisk:
      overrides.readConversationFromDisk ??
      (async () => ({ ...convMeta, messages: [], themeId: 'clara-dark' })),
    getConversations: overrides.getConversations ?? (async () => [convMeta]),
    maybeAutoTitleConversation: async () => ({ ok: false as const, reason: 'not_due' as const }),
    abortMessage,
  } as unknown as ElectronService;
  return {
    electron,
    doneSubject,
    configSubject,
    llamaServerLifecycleSubject,
    llamaServerProcessExitSubject,
    abortMessage,
    saveConversation,
  };
}

describe('ConversationSessionService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  function setup(overrides?: Parameters<typeof mockElectron>[0]): {
    service: ConversationSessionService;
    doneSubject: Subject<{ conversationId: string; outcome: 'completed' | 'aborted' | 'error' }>;
    configSubject: Subject<AppConfig>;
    llamaServerLifecycleSubject: Subject<LlamaServerLifecycleEvent>;
    llamaServerProcessExitSubject: Subject<LlamaServerProcessExitEvent>;
    abortMessage: ReturnType<typeof vi.fn>;
    saveConversation: ReturnType<typeof vi.fn>;
  } {
    const {
      electron,
      doneSubject,
      configSubject,
      llamaServerLifecycleSubject,
      llamaServerProcessExitSubject,
      abortMessage,
      saveConversation,
    } = mockElectron(overrides);
    TestBed.configureTestingModule({
      providers: [
        ConversationSessionService,
        { provide: ElectronService, useValue: electron },
        {
          provide: TtsPlaybackService,
          useValue: {
            feedStreamingAssistantText: vi.fn(),
            flushStreamingAssistantText: vi.fn(),
          },
        },
      ],
    });
    const service = TestBed.inject(ConversationSessionService);
    service.bindHooks({
      getCurrentWorkspaceId: () => 'ws-1',
      getSpeechSettings: () => ({ enabled: false, voice: '', speed: 1 }),
    });
    return {
      service,
      doneSubject,
      configSubject,
      llamaServerLifecycleSubject,
      llamaServerProcessExitSubject,
      abortMessage,
      saveConversation,
    };
  }

  it('abandons stale HITL on load when not streaming and persists cancelled status', async () => {
    const { service, saveConversation } = setup();
    await service.loadConversation('test-conv', 'ws-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(saveConversation).toHaveBeenCalled();
    const saved = saveConversation.mock.calls.at(-1)?.[0] as Conversation;
    const diff = saved.messages.find((m) => m.role === 'diff');
    expect(diff).toEqual(
      expect.objectContaining({
        reviewStatus: 'cancelled',
        reviewSummary: STALE_HITL_SUMMARY,
      }),
    );
  });

  it('skips assistant persist when done outcome is aborted', async () => {
    const { service, doneSubject, saveConversation } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('test-conv');
    service.streamingParts.set([{ streamTag: 'primary', label: '', text: 'partial reply' }]);

    saveConversation.mockClear();
    doneSubject.next({ conversationId: 'test-conv', outcome: 'aborted' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.streamingParts()).toEqual([]);
    expect(service.messages().some((m) => m.role === 'assistant')).toBe(false);
    expect(saveConversation).not.toHaveBeenCalled();
  });

  it('preserves reasoning stream text of a backgrounded conversation when switching to a new conversation', async () => {
    const convAMeta: ConversationMeta = {
      id: 'conv-a',
      title: 'A',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      customTitle: false,
    };
    const { service, doneSubject, saveConversation } = setup({
      newConversation: async () => ({
        ...convAMeta,
        id: 'conv-b',
        title: 'B',
        messages: [],
        themeId: 'clara-dark',
      }),
      readConversationFromDisk: async (id) => ({
        ...convAMeta,
        id,
        messages: [],
        themeId: 'clara-dark',
      }),
      getConversations: async () => [
        convAMeta,
        { ...convAMeta, id: 'conv-b', title: 'B' },
      ],
    });

    service.activeConversationId.set('conv-a');
    service.addPending('conv-a');
    service.streamingParts.set([
      { streamTag: 'reasoning', label: '', text: 'thinking hard about the request' },
    ]);

    await service.onNewConversation('ws-1');

    expect(service.activeConversationId()).toBe('conv-b');
    expect(service.streamingParts()).toEqual([]);

    saveConversation.mockClear();
    doneSubject.next({ conversationId: 'conv-a', outcome: 'completed' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(saveConversation).toHaveBeenCalled();
    const saved = saveConversation.mock.calls.at(-1)?.[0] as Conversation;
    const assistant = saved.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.reasoningStreams?.some((p) => p.text.includes('thinking hard'))).toBe(true);
  });

  it('sets creatingConversation while new-conversation IPC is in flight and ignores overlapping calls', async () => {
    const convMeta: ConversationMeta = {
      id: 'conv-a',
      title: 'A',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      customTitle: false,
    };
    const created: Conversation = {
      ...convMeta,
      id: 'conv-b',
      title: 'B',
      messages: [],
      themeId: 'clara-dark',
    };
    let releaseNew!: (value: Conversation) => void;
    const newConversation = vi.fn(
      () =>
        new Promise<Conversation>((resolve) => {
          releaseNew = resolve;
        }),
    );
    const { service } = setup({ newConversation });

    const first = service.onNewConversation('ws-1');
    expect(service.creatingConversation()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(newConversation).toHaveBeenCalledTimes(1);

    await service.onNewConversation('ws-1');
    expect(newConversation).toHaveBeenCalledTimes(1);

    releaseNew(created);
    await first;
    expect(service.creatingConversation()).toBe(false);
    expect(service.activeConversationId()).toBe('conv-b');
  });

  it('aborts pending streams and clears loading when the active llama-server stops', async () => {
    const { service, configSubject, llamaServerLifecycleSubject, abortMessage } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('test-conv');
    service.streamingParts.set([{ streamTag: 'primary', label: '', text: 'partial' }]);
    configSubject.next(localLlamaConfig());

    llamaServerLifecycleSubject.next({ phase: 'stopped', modelId: 'local-model' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(abortMessage).toHaveBeenCalledWith('test-conv');
    expect(service.pendingIds().has('test-conv')).toBe(false);
    expect(service.loading()).toBe(false);
    expect(service.streamingParts()).toEqual([]);
  });

  it('aborts pending streams when the active llama chat process exits', async () => {
    const { service, configSubject, llamaServerProcessExitSubject, abortMessage } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('test-conv');
    configSubject.next(localLlamaConfig());

    llamaServerProcessExitSubject.next({
      modelId: 'local-model',
      stream: 'chat',
      code: 1,
      signal: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(abortMessage).toHaveBeenCalledWith('test-conv');
    expect(service.pendingIds().has('test-conv')).toBe(false);
  });

  it('does not abort pending streams when a different llama model stops', async () => {
    const { service, configSubject, llamaServerLifecycleSubject, abortMessage } = setup();
    service.addPending('test-conv');
    configSubject.next(localLlamaConfig('local-model'));

    llamaServerLifecycleSubject.next({ phase: 'stopped', modelId: 'other-model' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(abortMessage).not.toHaveBeenCalled();
    expect(service.pendingIds().has('test-conv')).toBe(true);
  });

  it('assigns an id on user messages and applyRestoredMessages drops the restored user row', async () => {
    const { service } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('test-conv');
    service.pushMessage('user', 'first');
    service.pushMessage('assistant', 'reply');
    service.pushMessage('user', 'second');
    const first = service.messages()[0];
    expect(first?.role).toBe('user');
    if (first?.role === 'user') {
      expect(first.id).toBeTruthy();
    }
    service.applyRestoredMessages(service.messages().slice(0, 2));
    service.removePending('test-conv');
    expect(service.messages()).toHaveLength(2);
    expect(service.messages()[0]).toMatchObject({ role: 'user', text: 'first' });
    expect(service.messages()[1]).toMatchObject({ role: 'assistant', text: 'reply' });
    expect(service.pendingIds().has('test-conv')).toBe(false);
    expect(service.streamingParts()).toEqual([]);
  });
});
