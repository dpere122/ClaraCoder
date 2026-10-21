import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationFile, ParsedAgentStreamPayload } from '../../../shared';
import { parseAgentStreamPayload } from '../../../shared';

const mocks = vi.hoisted(() => ({
  conversations: new Map<string, ConversationFile>(),
  deleted: new Set<string>(),
  journal: [] as unknown[],
  pythonControlFetch: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../conversations-db', () => ({
  getConversationById: (id: string) => mocks.conversations.get(id) ?? null,
  isConversationDeleted: (id: string) => mocks.deleted.has(id),
  createSubagentConversation: (conv: ConversationFile) => {
    if (mocks.deleted.has(conv.id) || mocks.conversations.has(conv.id)) {
      return false;
    }
    mocks.conversations.set(conv.id, conv);
    return true;
  },
  appendConversationFileJournal: (row: unknown) => {
    mocks.journal.push(row);
  },
}));

vi.mock('../../python/http-client', () => ({
  pythonControlFetch: mocks.pythonControlFetch,
}));

import { createSubagentRelay } from './chat-subagent-relay';

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

function parsed(obj: Record<string, unknown>): ParsedAgentStreamPayload {
  return parseAgentStreamPayload(JSON.stringify(obj));
}

function started(id = CHILD, parent = PARENT, extra: Record<string, unknown> = {}): ParsedAgentStreamPayload {
  return parsed({
    type: 'subagent_started',
    conversation_id: id,
    parent_conversation_id: parent,
    parent_turn_id: 'parent-turn-1',
    name: 'Reader',
    task: 'Summarize README.md',
    status_id: 'run-1',
    ...extra,
  });
}

function wrapped(payload: Record<string, unknown>, id = CHILD): ParsedAgentStreamPayload {
  return parsed({ type: 'subagent_event', conversation_id: id, payload });
}

describe('createSubagentRelay', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.conversations.clear();
    mocks.deleted.clear();
    mocks.journal.length = 0;
    mocks.pythonControlFetch.mockClear();
    mocks.conversations.set(PARENT, conversation(PARENT));
    send = vi.fn();
  });

  it('creates the child row under its parent before announcing it', () => {
    const relay = createSubagentRelay(() => send);
    expect(relay.handle(started(CHILD, PARENT, { background: true }))).toBe(true);

    const child = mocks.conversations.get(CHILD);
    expect(child).toMatchObject({
      title: 'Reader',
      workspaceId: 'ws-1',
      themeId: 'theme-1',
      customTitle: true,
      parentConversationId: PARENT,
      parentTurnId: 'parent-turn-1',
    });
    expect(child?.messages).toEqual([
      { role: 'user', id: expect.any(String), text: 'Summarize README.md', fromAgent: true },
    ]);
    expect(send).toHaveBeenCalledWith('subagent-started', {
      meta: expect.objectContaining({ id: CHILD, parentConversationId: PARENT, customTitle: true }),
      task: 'Summarize README.md',
      userMessageId: (child?.messages[0] as { id: string }).id,
      statusId: 'run-1',
      background: true,
    });
    expect(relay.runningIds()).toEqual([CHILD]);
  });

  it('drops a start with a bad, colliding or self id, an unknown, deleted or sub-agent parent', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started('bad id!'));
    relay.handle(started(PARENT));
    mocks.conversations.set('existing-123456', conversation('existing-123456'));
    relay.handle(started('existing-123456'));
    relay.handle(started(CHILD, 'unknown-parent-1'));
    mocks.conversations.set('child-parent-01', conversation('child-parent-01', { parentConversationId: PARENT }));
    relay.handle(started(CHILD, 'child-parent-01'));
    mocks.deleted.add(PARENT);
    relay.handle(started(CHILD));
    expect(send).not.toHaveBeenCalled();
    expect(mocks.conversations.has(CHILD)).toBe(false);
  });

  it('routes the child stream to the child, and its approval cards to the parent dock', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started());
    relay.handle(wrapped({ type: 'chunk', delta: 'hi', stream_tag: 'agent' }));
    expect(send).toHaveBeenCalledWith('message-chunk', CHILD, 'hi', 'agent');

    relay.handle(
      wrapped({
        type: 'accept_command',
        acceptCommand: { version: 1, requestId: 'req-1', title: 'Run', kind: 'deferred_tool' },
      }),
    );
    expect(send).toHaveBeenCalledWith(
      'message-accept-command',
      PARENT,
      expect.objectContaining({ requestId: 'req-1', subagent: { conversationId: CHILD, name: 'Reader' } }),
    );
  });

  it('journals the child edits under the parent turn that spawned it', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started());
    relay.handle(
      wrapped({ type: 'file_journal', userMessageId: 'other', relativePath: 'a.txt', op: 'modify', beforeContent: 'old' }),
    );
    expect(mocks.journal).toEqual([
      expect.objectContaining({ conversationId: PARENT, userMessageId: 'parent-turn-1', relativePath: 'a.txt' }),
    ]);
  });

  it('writes nothing more for a sub-agent whose conversation (or parent) was deleted', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started());
    send.mockClear();
    mocks.deleted.add(CHILD); // e.g. a restore removed the turn that spawned it
    relay.handle(
      wrapped({ type: 'file_journal', userMessageId: 'other', relativePath: 'a.txt', op: 'modify', beforeContent: 'old' }),
    );
    relay.handle(wrapped({ type: 'chunk', delta: 'late' }));
    expect(mocks.journal).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(relay.runningIds()).toEqual([]);
  });

  it('cancels a plan-mode question nobody could answer instead of forwarding it', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started());
    relay.handle(
      wrapped({ type: 'agent_question', agentQuestion: { version: 1, requestId: 'q-1', title: 'Which?', questions: [] } }),
    );
    expect(send).not.toHaveBeenCalledWith('message-agent-question', expect.anything(), expect.anything());
    expect(mocks.pythonControlFetch).toHaveBeenCalledWith(
      '/chat/agent-question-answers',
      expect.objectContaining({ body: expect.stringContaining('"session_id":"child-abc12345"') }),
    );
  });

  it('drops nested sub-agent events and events of unknown children', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started());
    expect(relay.handle(wrapped({ type: 'subagent_started', conversation_id: 'grandchild-1234' }))).toBe(true);
    expect(relay.handle(wrapped({ type: 'chunk', delta: 'x' }, 'unknown-child-1'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends one done per child with its task message id, then forgets it', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started());
    const userMessageId = (mocks.conversations.get(CHILD)?.messages[0] as { id: string }).id;
    relay.handle(parsed({ type: 'subagent_finished', conversation_id: CHILD, outcome: 'completed' }));
    relay.handle(parsed({ type: 'subagent_finished', conversation_id: CHILD, outcome: 'completed' }));
    relay.handle(wrapped({ type: 'chunk', delta: 'late' }));
    relay.finishAll('error');

    expect(send.mock.calls.filter((c) => c[0] === 'message-done')).toEqual([
      ['message-done', CHILD, 'completed', [], userMessageId],
    ]);
    expect(send).not.toHaveBeenCalledWith('message-chunk', expect.anything(), 'late', undefined);
    expect(relay.runningIds()).toEqual([]);
  });

  it('finishAll settles the children that never reported (e.g. the sidecar restarted)', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(started());
    relay.handle(started('child-def67890'));
    relay.handle(parsed({ type: 'subagent_finished', conversation_id: CHILD, outcome: 'completed' }));
    relay.finishAll('error');
    relay.finishAll('error');

    expect(send.mock.calls.filter((c) => c[0] === 'message-done').map((c) => [c[1], c[2]])).toEqual([
      [CHILD, 'completed'],
      ['child-def67890', 'error'],
    ]);
  });

  it('passes on results-ready for a live parent only', () => {
    const relay = createSubagentRelay(() => send);
    relay.handle(parsed({ type: 'subagent_results_ready', parent_conversation_id: PARENT, names: ['a', 'b'] }));
    expect(send).toHaveBeenCalledWith('subagent-results-ready', { parentConversationId: PARENT, names: ['a', 'b'] });
    mocks.deleted.add(PARENT);
    send.mockClear();
    relay.handle(parsed({ type: 'subagent_results_ready', parent_conversation_id: PARENT, names: [] }));
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers the events of each sub-agent to the renderer of its own parent only', () => {
    mocks.conversations.set('parent-two-0001', conversation('parent-two-0001'));
    const first = vi.fn();
    const second = vi.fn();
    const relay = createSubagentRelay((parentId) => (parentId === PARENT ? first : second));
    relay.handle(started(CHILD, PARENT));
    relay.handle(started('child-two-0001', 'parent-two-0001'));
    relay.handle(wrapped({ type: 'chunk', delta: 'one' }, CHILD));
    relay.handle(wrapped({ type: 'chunk', delta: 'two' }, 'child-two-0001'));

    expect(first.mock.calls.map((c) => c[0])).toEqual(['subagent-started', 'message-chunk']);
    expect(second.mock.calls.map((c) => c[0])).toEqual(['subagent-started', 'message-chunk']);
    expect(first).toHaveBeenCalledWith('message-chunk', CHILD, 'one', undefined);
    expect(second).toHaveBeenCalledWith('message-chunk', 'child-two-0001', 'two', undefined);
  });

  it('leaves ordinary payloads to the caller', () => {
    expect(createSubagentRelay(() => send).handle(parsed({ type: 'chunk', delta: 'text' }))).toBe(false);
  });
});
