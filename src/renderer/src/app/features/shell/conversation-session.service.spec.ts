import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AcceptCommandPayload,
  AppConfig,
  Conversation,
  ConversationMeta,
  LlamaServerLifecycleEvent,
  LlamaServerProcessExitEvent,
  LlmStatus,
  SubagentStartedEvent,
  TurnEditedFile,
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

type DoneEvent = {
  conversationId: string;
  outcome: 'completed' | 'aborted' | 'error';
  editedFiles?: TurnEditedFile[];
  userMessageId?: string;
};

function mockElectron(overrides: Partial<{
  loadConversation: ElectronService['loadConversation'];
  saveConversation: ReturnType<typeof vi.fn>;
  newConversation: ElectronService['newConversation'];
  readConversationFromDisk: ElectronService['readConversationFromDisk'];
  getConversations: ElectronService['getConversations'];
}> = {}) {
  const doneSubject = new Subject<DoneEvent>();
  const chunkSubject = new Subject<{ conversationId: string; delta: string; streamTag?: string }>();
  const llmStatusSubject = new Subject<{ conversationId: string; status: LlmStatus }>();
  const acceptCommandSubject = new Subject<{ conversationId: string; payload: AcceptCommandPayload }>();
  const subagentStartedSubject = new Subject<SubagentStartedEvent>();
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
    chunk$: chunkSubject.asObservable(),
    toolReadChunk$: new Subject().asObservable(),
    toolExecChunk$: new Subject().asObservable(),
    toolExecComplete$: new Subject().asObservable(),
    appendConversationFileJournal: vi.fn(async () => ({ ok: true })),
    restoreConversationTimeline: vi.fn(async () => ({ ok: false, error: 'not mocked' })),
    listConversationFileJournal: vi.fn(async () => []),
    acceptCommand$: acceptCommandSubject.asObservable(),
    deleteConfirm$: new Subject().asObservable(),
    plannerProgress$: new Subject().asObservable(),
    planConfirm$: new Subject().asObservable(),
    agentQuestion$: new Subject().asObservable(),
    themeProposal$: new Subject().asObservable(),
    llmStatus$: llmStatusSubject.asObservable(),
    finalText$: new Subject().asObservable(),
    clearPrimaryStream$: new Subject().asObservable(),
    promotePrimaryToNudge$: new Subject().asObservable(),
    llmTokenUsage$: new Subject().asObservable(),
    done$: doneSubject.asObservable(),
    subagentStarted$: subagentStartedSubject.asObservable(),
    flushPendingStreamBatch: vi.fn(),
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
    chunkSubject,
    llmStatusSubject,
    acceptCommandSubject,
    subagentStartedSubject,
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
    doneSubject: Subject<DoneEvent>;
    chunkSubject: Subject<{ conversationId: string; delta: string; streamTag?: string }>;
    llmStatusSubject: Subject<{ conversationId: string; status: LlmStatus }>;
    acceptCommandSubject: Subject<{ conversationId: string; payload: AcceptCommandPayload }>;
    subagentStartedSubject: Subject<SubagentStartedEvent>;
    configSubject: Subject<AppConfig>;
    llamaServerLifecycleSubject: Subject<LlamaServerLifecycleEvent>;
    llamaServerProcessExitSubject: Subject<LlamaServerProcessExitEvent>;
    abortMessage: ReturnType<typeof vi.fn>;
    saveConversation: ReturnType<typeof vi.fn>;
  } {
    const {
      electron,
      doneSubject,
      chunkSubject,
      llmStatusSubject,
      acceptCommandSubject,
      subagentStartedSubject,
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
      chunkSubject,
      llmStatusSubject,
      acceptCommandSubject,
      subagentStartedSubject,
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

  it('keeps the partial reply of an aborted turn, marked stopped, with running tools settled', async () => {
    const { service, doneSubject } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('test-conv');
    service.streamingParts.set([
      { streamTag: 'agent', label: '', text: 'partial reply' },
      { streamTag: 'tool-trail:t1', label: 'read_workspace_file', text: 'a.ts', toolChainState: 'running' },
    ]);

    doneSubject.next({ conversationId: 'test-conv', outcome: 'aborted' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.streamingParts()).toEqual([]);
    const assistant = service.messages().find((m) => m.role === 'assistant');
    expect(assistant).toMatchObject({ role: 'assistant', text: 'partial reply', endedEarly: 'stopped' });
    const tool = assistant?.role === 'assistant' ? assistant.auxiliaryStreamTimeline?.find((p) => p.streamTag === 'tool-trail:t1') : undefined;
    expect(tool).toMatchObject({ toolChainState: 'error', toolStopped: true });
  });

  it('saves nothing for an aborted turn that produced nothing', async () => {
    const { service, doneSubject, saveConversation } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('test-conv');

    saveConversation.mockClear();
    doneSubject.next({ conversationId: 'test-conv', outcome: 'aborted' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.messages().some((m) => m.role === 'assistant')).toBe(false);
  });

  it('attaches the turn edited-file summary from done$ to the new assistant message', async () => {
    const { service, doneSubject } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('test-conv');
    service.streamingParts.set([{ streamTag: 'primary', label: '', text: 'done editing' }]);
    const editedFiles: TurnEditedFile[] = [
      { relativePath: 'a.py', op: 'modify', additions: 3, deletions: 1, status: 'kept' },
    ];

    doneSubject.next({ conversationId: 'test-conv', outcome: 'completed', editedFiles });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const assistant = service.messages().find((m) => m.role === 'assistant');
    expect(assistant?.role === 'assistant' && assistant.editedFiles).toEqual(editedFiles);
  });

  it('mirrors reset statuses onto the assistant message closing a turn', () => {
    const { service } = setup();
    const kept: TurnEditedFile = { relativePath: 'a.py', op: 'modify', additions: 1, deletions: 0, status: 'kept' };
    service.messages.set([
      { role: 'user', text: 'first', id: 'u1' },
      { role: 'assistant', text: 'ok', editedFiles: [kept] },
      { role: 'user', text: 'second', id: 'u2' },
      { role: 'assistant', text: 'ok again', editedFiles: [kept] },
    ]);

    service.applyTurnEditedFiles('u1', [{ ...kept, status: 'reset' }]);

    const msgs = service.messages();
    expect(msgs[1]?.role === 'assistant' && msgs[1].editedFiles?.[0]?.status).toBe('reset');
    expect(msgs[3]?.role === 'assistant' && msgs[3].editedFiles?.[0]?.status).toBe('kept');
  });

  it('queues workspace notes per conversation until taken', () => {
    const { service } = setup();
    service.queueWorkspaceNote('c1', 'User reset `a.py` from turn 1 to its pre-edit state');
    service.queueWorkspaceNote('c2', 'other');
    service.queueWorkspaceNote('c1', '  ');

    expect(service.takeWorkspaceNotes('c1')).toEqual(['User reset `a.py` from turn 1 to its pre-edit state']);
    expect(service.takeWorkspaceNotes('c1')).toEqual([]);
    service.requeueWorkspaceNotes('c2', ['first']);
    expect(service.takeWorkspaceNotes('c2')).toEqual(['first', 'other']);
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
  it('interrupt keeps the live reply as interrupted, fences its late events and waits for its done', async () => {
    const { service, doneSubject, chunkSubject, abortMessage } = setup();
    service.activeConversationId.set('test-conv');
    service.prepareForSend('test-conv');
    const oldTurn = service.pushMessage('user', 'first');
    service.beginLiveTurn('test-conv', oldTurn);
    service.streamingParts.set([{ streamTag: 'agent', label: '', text: 'working on it' }]);

    service.interruptLiveTurn('test-conv');
    expect(service.drainingConversationIds().has('test-conv')).toBe(true);
    expect(service.messages().at(-1)).toMatchObject({ role: 'assistant', text: 'working on it', endedEarly: 'interrupted' });

    service.prepareForSend('test-conv');
    const newTurn = service.pushMessage('user', 'actually, do this');
    service.beginLiveTurn('test-conv', newTurn);
    const drained = service.drainInterruptedTurn('test-conv');

    // The old stream's late chunk must not reach the new turn.
    chunkSubject.next({ conversationId: 'test-conv', delta: 'stale text', streamTag: 'agent' });
    expect(service.streamingParts()).toEqual([]);
    await Promise.resolve();
    expect(abortMessage).toHaveBeenCalledWith('test-conv');

    const files: TurnEditedFile[] = [{ relativePath: 'a.py', op: 'modify', additions: 1, deletions: 0, status: 'kept' }];
    doneSubject.next({ conversationId: 'test-conv', outcome: 'aborted', editedFiles: files, userMessageId: oldTurn });
    await drained;

    expect(service.drainingConversationIds().has('test-conv')).toBe(false);
    expect(service.pendingIds().has('test-conv')).toBe(true);
    const interrupted = service.messages().find((m) => m.role === 'assistant');
    expect(interrupted?.role === 'assistant' && interrupted.editedFiles).toEqual(files);

    chunkSubject.next({ conversationId: 'test-conv', delta: 'new reply', streamTag: 'agent' });
    expect(service.streamingParts()).toEqual([{ streamTag: 'agent', label: '', text: 'new reply' }]);
  });

  it('ignores a late done of a turn that was already discarded', async () => {
    const { service, doneSubject } = setup();
    service.activeConversationId.set('test-conv');
    service.prepareForSend('test-conv');
    const turn = service.pushMessage('user', 'first');
    service.beginLiveTurn('test-conv', turn);
    service.streamingParts.set([{ streamTag: 'agent', label: '', text: 'partial' }]);

    service.discardLiveTurn('test-conv');
    doneSubject.next({ conversationId: 'test-conv', outcome: 'aborted', userMessageId: turn });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.messages().some((m) => m.role === 'assistant')).toBe(false);
  });

  it('keeps tool pills of a turn streaming in the background', () => {
    const { service, llmStatusSubject } = setup();
    service.activeConversationId.set('test-conv');
    service.addPending('bg-conv');

    llmStatusSubject.next({
      conversationId: 'bg-conv',
      status: { id: 'run-1', label: 'read_workspace_file', detail: 'src/a.ts', state: 'running', source: 'tool' },
    });

    expect(service.streamPartsFor('bg-conv')).toEqual([
      expect.objectContaining({ streamTag: 'tool-trail:run-1', toolChainState: 'running', toolTarget: 'src/a.ts' }),
    ]);
  });

  it('tracks a sub-agent run from its start to its done and drops its pending approval cards', async () => {
    const { service, subagentStartedSubject, acceptCommandSubject, doneSubject } = setup();
    const parent: ConversationMeta = {
      id: 'test-conv',
      title: 'Parent',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      workspaceId: 'ws-1',
      customTitle: false,
    };
    service.conversations.set([parent]);
    service.activeConversationId.set('test-conv');
    service.prepareForSend('test-conv');
    const parentTurn = service.pushMessage('user', 'delegate it');
    service.beginLiveTurn('test-conv', parentTurn);

    subagentStartedSubject.next({
      meta: {
        id: 'child-1',
        title: 'Reader',
        createdAt: '2026-10-20T00:00:01.000Z',
        updatedAt: '2026-10-20T00:00:01.000Z',
        workspaceId: 'ws-1',
        customTitle: true,
        parentConversationId: 'test-conv',
        parentTurnId: parentTurn,
      },
      task: 'Read the README',
      userMessageId: 'child-turn-1',
    });

    expect(service.pendingIds().has('child-1')).toBe(true);
    expect(service.conversations().map((c) => c.id)).toEqual(['child-1', 'test-conv']);
    expect(service.subagentRunsFor('test-conv')).toEqual([
      expect.objectContaining({ conversationId: 'child-1', name: 'Reader', task: 'Read the README' }),
    ]);
    expect(service.isSubagentConversation('child-1')).toBe(true);

    acceptCommandSubject.next({
      conversationId: 'test-conv',
      payload: {
        version: 1,
        requestId: 'req-1',
        kind: 'deferred_tool',
        title: 'Run npm test',
        message: '',
        confirmLabel: 'Run',
        cancelLabel: 'Cancel',
        commandText: 'npm test',
        details: [],
        subagent: { conversationId: 'child-1', name: 'Reader' },
      },
    });
    expect(service.pendingSubagentApprovals().get('child-1')).toEqual(['req-1']);

    doneSubject.next({ conversationId: 'child-1', outcome: 'completed', userMessageId: 'child-turn-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.pendingIds().has('child-1')).toBe(false);
    expect(service.subagentRunsFor('test-conv')).toEqual([
      expect.objectContaining({ conversationId: 'child-1', outcome: 'completed' }),
    ]);
    expect(service.pendingSubagentApprovals().has('child-1')).toBe(false);
    const card = service.messages().find((m) => m.role === 'accept_command');
    expect(card).toMatchObject({ reviewStatus: 'cancelled' });

    // The parent turn ends: its finished sub-agents leave the dock.
    doneSubject.next({ conversationId: 'test-conv', outcome: 'completed', userMessageId: parentTurn });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.subagentRunsFor('test-conv')).toEqual([]);
  });
  it('abandons stale cards of restored messages but keeps the cards of running sub-agents', () => {
    const { service } = setup();
    service.addPending('child-1');
    const card = (requestId: string, subagent?: { conversationId: string; name: string }) => ({
      role: 'accept_command' as const,
      id: requestId,
      payload: {
        version: 1 as const,
        requestId,
        kind: 'deferred_tool' as const,
        title: 'Run npm test',
        message: '',
        confirmLabel: 'Run',
        cancelLabel: 'Cancel',
        commandText: 'npm test',
        details: [],
        ...(subagent ? { subagent } : {}),
      },
    });
    const restored = service.abandonStaleHitl([
      card('main-req'),
      card('child-req', { conversationId: 'child-1', name: 'Reader' }),
      card('gone-req', { conversationId: 'child-gone', name: 'Old' }),
    ] as unknown as Parameters<typeof service.abandonStaleHitl>[0]);
    expect(restored.map((m) => (m as { reviewStatus?: string }).reviewStatus)).toEqual([
      'cancelled',
      undefined,
      'cancelled',
    ]);
  });
  it('keeps a finished sub-agent card until a turn of its parent ends, even if it ended between turns', async () => {
    const { service, subagentStartedSubject, doneSubject } = setup();
    service.conversations.set([
      { id: 'test-conv', title: 'P', createdAt: 'a', updatedAt: 'a', workspaceId: 'ws-1', customTitle: false },
    ]);
    service.activeConversationId.set('test-conv');
    subagentStartedSubject.next({
      meta: {
        id: 'child-9',
        title: 'Worker',
        createdAt: 'b',
        updatedAt: 'b',
        workspaceId: 'ws-1',
        customTitle: true,
        parentConversationId: 'test-conv',
        parentTurnId: 'old-turn',
      },
      task: 'Do it',
      userMessageId: 'child-turn-9',
      background: true,
    });
    expect(service.subagentRunsFor('test-conv')[0]).toMatchObject({ background: true });

    // The parent has no turn running: the card turns Done and stays.
    doneSubject.next({ conversationId: 'child-9', outcome: 'completed', userMessageId: 'child-turn-9' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.subagentRunsFor('test-conv')).toEqual([expect.objectContaining({ outcome: 'completed' })]);

    // The parent's next turn (the one that takes in the report) ends: the card leaves.
    service.prepareForSend('test-conv');
    const turn = service.pushMessage('user', 'next');
    service.beginLiveTurn('test-conv', turn);
    doneSubject.next({ conversationId: 'test-conv', outcome: 'completed', userMessageId: turn });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.subagentRunsFor('test-conv')).toEqual([]);
  });

  it('saves a stopped marker for a sub-agent stopped before it streamed anything', async () => {
    const { service, subagentStartedSubject, doneSubject, saveConversation } = setup({
      readConversationFromDisk: async (id: string) => ({
        id,
        title: 'Quick',
        createdAt: 'b',
        updatedAt: 'b',
        workspaceId: 'ws-2',
        themeId: 'clara-dark',
        customTitle: true,
        parentConversationId: 'test-conv',
        messages: [{ role: 'user', id: 'child-turn-5', text: 'Do it', fromAgent: true }],
      }),
    });
    service.activeConversationId.set('test-conv');
    // Its parent lives in another workspace, so its meta is not in the list on screen.
    subagentStartedSubject.next({
      meta: {
        id: 'child-5',
        title: 'Quick',
        createdAt: 'b',
        updatedAt: 'b',
        workspaceId: 'ws-2',
        customTitle: true,
        parentConversationId: 'test-conv',
      },
      task: 'Do it',
      userMessageId: 'child-turn-5',
    });
    saveConversation.mockClear();

    doneSubject.next({ conversationId: 'child-5', outcome: 'aborted', userMessageId: 'child-turn-5' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const saved = saveConversation.mock.calls.at(-1)?.[0] as Conversation;
    expect(saved.id).toBe('child-5');
    expect(saved.messages.at(-1)).toEqual({ role: 'assistant', text: '', endedEarly: 'stopped' });
  });

  it('starts a sub-agent results turn in the open conversation with a marker message', async () => {
    const { service } = setup();
    service.activeConversationId.set('test-conv');

    const turn = await service.beginSubagentResultsTurn('test-conv', ['alpha', 'beta']);

    expect(turn).toMatchObject({ text: 'Results from sub-agents: alpha, beta', workspaceId: 'ws-1' });
    expect(service.pendingIds().has('test-conv')).toBe(true);
    expect(service.messages().at(-1)).toMatchObject({
      role: 'user',
      id: turn!.userMessageId,
      subagentResults: ['alpha', 'beta'],
    });
    // A conversation already running a turn takes the reports in itself.
    expect(await service.beginSubagentResultsTurn('test-conv', ['gamma'])).toBeNull();
  });

  it('writes the marker of a background results turn to disk before the turn starts', async () => {
    const { service, saveConversation } = setup();
    service.activeConversationId.set('other-conv');
    saveConversation.mockClear();

    const turn = await service.beginSubagentResultsTurn('test-conv', ['alpha']);

    expect(service.pendingIds().has('test-conv')).toBe(true);
    const saved = saveConversation.mock.calls.at(-1)?.[0] as Conversation;
    expect(saved.id).toBe('test-conv');
    expect(saved.messages.at(-1)).toMatchObject({ role: 'user', id: turn!.userMessageId, subagentResults: ['alpha'] });
  });
});
