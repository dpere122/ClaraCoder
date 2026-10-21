import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationFile, ConversationMeta } from '../../../shared';

const mocks = vi.hoisted(() => ({
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  pythonSsePost: vi.fn(),
  pythonControlFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  finalizeTurnEdits: vi.fn(async () => [] as unknown[]),
  conversations: new Map<string, ConversationFile>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.onHandlers.set(channel, handler);
    }),
    handle: vi.fn(),
  },
}));

vi.mock('../assert-trusted-renderer', () => ({
  assertTrustedAppRenderer: vi.fn(),
  assertTrustedMainRenderer: vi.fn(),
  assertTrustedMainRendererOrThrow: vi.fn(),
  isTrustedMainRenderer: vi.fn(() => true),
}));

vi.mock('../../python/http-client', () => ({
  pythonSsePost: mocks.pythonSsePost,
  pythonControlFetch: mocks.pythonControlFetch,
  pythonLongFetch: vi.fn(),
}));

vi.mock('../../python/server', () => ({ ensurePythonReady: vi.fn(async () => undefined) }));
vi.mock('../../state', () => ({ mainState: {} }));
vi.mock('../../windows/settings-window', () => ({
  createSettingsWindow: vi.fn(),
  notifySettingsRendererReady: vi.fn(),
  parseSettingsWindowTab: vi.fn(),
}));
vi.mock('../../turn-edits', () => ({ finalizeTurnEdits: mocks.finalizeTurnEdits }));
vi.mock('./conversation-timeline', () => ({ workspacePathForWorkspaceId: vi.fn(() => '/ws') }));

vi.mock('../../conversations-db', () => ({
  getConversationById: (id: string) => mocks.conversations.get(id) ?? null,
  getConversationMetaById: (id: string): ConversationMeta | null => {
    const c = mocks.conversations.get(id);
    return c ? { ...c } : null;
  },
  isConversationDeleted: () => false,
  createSubagentConversation: (conv: ConversationFile) => {
    if (mocks.conversations.has(conv.id)) {
      return false;
    }
    mocks.conversations.set(conv.id, conv);
    return true;
  },
  appendConversationFileJournal: vi.fn(),
}));

import { registerChatIpc } from './chat';
import { abortChatStream } from './chat-stream-state';

const PARENT = 'parent-conversation-1';
const CHILD = 'child-abc12345';

function conversation(id: string, extra: Partial<ConversationFile> = {}): ConversationFile {
  return {
    id,
    title: id,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    messages: [],
    workspaceId: 'ws-1',
    themeId: 'theme-1',
    customTitle: false,
    ...extra,
  };
}

function sse(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/** A `/chat/stream` response that sends `lines`, then (unless `open`) closes. Aborting errors it. */
function streamResponse(lines: string[], signal: AbortSignal, open = false) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      if (!open) {
        controller.close();
        return;
      }
      signal.addEventListener('abort', () => controller.error(new Error('aborted')));
    },
  });
  return { ok: true, status: 200, body };
}

function sendMessage(reply: ReturnType<typeof vi.fn>, conversationId = PARENT, userMessageId = 'turn-1') {
  const handler = mocks.onHandlers.get('message')!;
  return handler(
    { reply, sender: {} },
    conversationId,
    'hello',
    true,
    false,
    undefined,
    'ws-1',
    'agent',
    false,
    'kokoro',
    userMessageId,
    false,
    [],
  ) as Promise<void>;
}

describe('chat message stream', () => {
  beforeEach(() => {
    mocks.onHandlers.clear();
    mocks.pythonSsePost.mockReset();
    mocks.pythonControlFetch.mockClear();
    mocks.finalizeTurnEdits.mockReset();
    mocks.finalizeTurnEdits.mockResolvedValue([]);
    mocks.conversations.clear();
    mocks.conversations.set(PARENT, conversation(PARENT));
    registerChatIpc();
  });

  it('forwards the turn, sends done with the turn id, and ignores sub-agent events (they have their own channel)', async () => {
    mocks.pythonSsePost.mockImplementation(async (_path: string, _body: unknown, signal: AbortSignal) =>
      streamResponse(
        [
          sse({ type: 'subagent_started', conversation_id: CHILD, parent_conversation_id: PARENT, name: 'R', task: 't' }),
          sse({ type: 'chunk', delta: 'parent' }),
          sse('[DONE]'),
        ],
        signal,
      ),
    );
    const reply = vi.fn();
    await sendMessage(reply);

    expect(reply).toHaveBeenCalledWith('message-chunk', PARENT, 'parent', undefined);
    expect(reply).not.toHaveBeenCalledWith('subagent-started', expect.anything());
    expect(mocks.conversations.has(CHILD)).toBe(false);
    expect(reply.mock.calls.filter((c) => c[0] === 'message-done')).toEqual([
      ['message-done', PARENT, 'completed', [], 'turn-1'],
    ]);
  });

  it('asks Python to build the turn from waiting sub-agent reports when told to', async () => {
    mocks.pythonSsePost.mockImplementation(async (_path: string, _body: unknown, signal: AbortSignal) =>
      streamResponse([sse('[DONE]')], signal),
    );
    const handler = mocks.onHandlers.get('message')!;
    await (handler(
      { reply: vi.fn(), sender: {} },
      PARENT,
      'Results from sub-agents: a',
      true,
      false,
      undefined,
      'ws-1',
      'agent',
      false,
      'kokoro',
      'turn-2',
      false,
      [],
      true,
    ) as Promise<void>);
    expect(mocks.pythonSsePost).toHaveBeenCalledWith(
      '/chat/stream',
      expect.objectContaining({ continue_with_subagent_results: true, user_message_id: 'turn-2' }),
      expect.anything(),
    );
  });

  it('on abort sends an aborted done and leaves sub-agents to their own channel', async () => {
    mocks.pythonSsePost.mockImplementation(async (_path: string, _body: unknown, signal: AbortSignal) =>
      streamResponse([sse({ type: 'chunk', delta: 'x' })], signal, true),
    );
    const reply = vi.fn();
    const running = sendMessage(reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('message-chunk', PARENT, 'x', undefined));
    await abortChatStream(PARENT);
    await running;

    expect(reply.mock.calls.filter((c) => c[0] === 'message-done').map((c) => [c[1], c[2]])).toEqual([
      [PARENT, 'aborted'],
    ]);
    // Only the parent's own abort: its sub-agents keep running.
    expect(mocks.pythonControlFetch).toHaveBeenCalledTimes(1);
    expect(mocks.pythonControlFetch).toHaveBeenCalledWith(
      '/chat/abort',
      expect.objectContaining({ body: JSON.stringify({ session_id: PARENT }) }),
    );
  });

  it('sends no done when a newer stream replaced this one while its edits were snapshotted', async () => {
    let releaseFinalize!: () => void;
    mocks.finalizeTurnEdits.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFinalize = () => resolve([]);
        }),
    );
    mocks.pythonSsePost
      .mockImplementationOnce(async (_path: string, _body: unknown, signal: AbortSignal) =>
        streamResponse([sse('[DONE]')], signal),
      )
      .mockImplementationOnce(async (_path: string, _body: unknown, signal: AbortSignal) =>
        streamResponse([], signal, true),
      );
    const reply = vi.fn();
    const first = sendMessage(reply, PARENT, 'turn-1');
    await vi.waitFor(() => expect(mocks.finalizeTurnEdits).toHaveBeenCalled());
    // The newer turn supersedes the first while its done is being prepared.
    const second = sendMessage(reply, PARENT, 'turn-2');
    releaseFinalize();
    await first;

    expect(reply.mock.calls.filter((c) => c[0] === 'message-done')).toEqual([]);
    await abortChatStream(PARENT);
    await second;
  });

  it('refuses a turn for a sub-agent conversation (only the main agent prompts it)', async () => {
    mocks.conversations.set(CHILD, conversation(CHILD, { parentConversationId: PARENT }));
    const reply = vi.fn();
    await sendMessage(reply, CHILD, 'turn-9');
    expect(mocks.pythonSsePost).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('message-done', CHILD, 'error', [], 'turn-9');
  });
});
