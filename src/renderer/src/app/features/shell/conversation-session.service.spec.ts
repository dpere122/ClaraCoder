import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationMeta } from '@shared/index';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { ConversationSessionService } from './conversation-session.service';
import { STALE_HITL_SUMMARY } from './abandon-stale-hitl';

function mockElectron(overrides: Partial<{
  loadConversation: ElectronService['loadConversation'];
  saveConversation: ReturnType<typeof vi.fn>;
  newConversation: ElectronService['newConversation'];
  readConversationFromDisk: ElectronService['readConversationFromDisk'];
  getConversations: ElectronService['getConversations'];
}> = {}) {
  const doneSubject = new Subject<{ conversationId: string; outcome: 'completed' | 'aborted' | 'error' }>();
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
    diff$: new Subject().asObservable(),
    stagedTransferBatch$: new Subject().asObservable(),
    acceptCommand$: new Subject().asObservable(),
    copyConfirm$: new Subject().asObservable(),
    deleteConfirm$: new Subject().asObservable(),
    plannerProgress$: new Subject().asObservable(),
    planConfirm$: new Subject().asObservable(),
    agentQuestion$: new Subject().asObservable(),
    llmStatus$: new Subject().asObservable(),
    finalText$: new Subject().asObservable(),
    clearPrimaryStream$: new Subject().asObservable(),
    done$: doneSubject.asObservable(),
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
          themeId: 'woodland',
        }) satisfies Conversation),
    newConversation:
      overrides.newConversation ??
      (async () => ({
        ...convMeta,
        id: 'conv-b',
        messages: [],
        themeId: 'woodland',
      }) satisfies Conversation),
    loadConfig: async () => ({
      currentWorkspaceId: 'ws-1',
      workspaces: [],
      themeId: 'woodland',
      activeLlmModelId: 'default',
      llmProviders: [],
      lastActiveConversationByWorkspaceId: {},
    }),
    setLastActiveConversation: async () => ({}),
    saveConversation,
    readConversationFromDisk:
      overrides.readConversationFromDisk ??
      (async () => ({ ...convMeta, messages: [], themeId: 'woodland' })),
    getConversations: overrides.getConversations ?? (async () => [convMeta]),
    maybeAutoTitleConversation: async () => ({ ok: false as const, reason: 'not_due' as const }),
    abortMessage: async () => undefined,
  } as unknown as ElectronService;
  return { electron, doneSubject, saveConversation };
}

describe('ConversationSessionService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  function setup(overrides?: Parameters<typeof mockElectron>[0]): {
    service: ConversationSessionService;
    doneSubject: Subject<{ conversationId: string; outcome: 'completed' | 'aborted' | 'error' }>;
    saveConversation: ReturnType<typeof vi.fn>;
  } {
    const { electron, doneSubject, saveConversation } = mockElectron(overrides);
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
    return { service, doneSubject, saveConversation };
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
        themeId: 'woodland',
      }),
      readConversationFromDisk: async (id) => ({
        ...convAMeta,
        id,
        messages: [],
        themeId: 'woodland',
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
});
