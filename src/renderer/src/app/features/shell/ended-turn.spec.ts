import { describe, expect, it } from 'vitest';
import type { ConversationMessage, StreamPart } from '@shared/index';
import {
  attachTurnEditedFiles,
  cancelSubagentApprovals,
  ENDED_TURN_HITL_SUMMARY,
  settleInFlightStreamParts,
  settleLiveTurnMessages,
  SUBAGENT_ENDED_HITL_SUMMARY,
} from './ended-turn';

const acceptCard = (requestId: string, subagentId?: string): ConversationMessage => ({
  role: 'accept_command',
  payload: {
    version: 1,
    requestId,
    kind: 'deferred_tool',
    title: 'Run',
    message: '',
    confirmLabel: 'Run',
    cancelLabel: 'Cancel',
    commandText: 'npm test',
    details: [],
    ...(subagentId ? { subagent: { conversationId: subagentId, name: 'Sub' } } : {}),
  },
  reviewStatus: 'pending',
});

describe('settleInFlightStreamParts', () => {
  it('stops running tool rows and closes open command lanes, leaving finished parts alone', () => {
    const parts: StreamPart[] = [
      { streamTag: 'agent', label: '', text: 'hi' },
      { streamTag: 'tool-trail:a', label: 'read_workspace_file', text: 'x', toolChainState: 'running' },
      { streamTag: 'tool-trail:b', label: 'read_workspace_file', text: 'y', toolChainState: 'complete' },
      { streamTag: 'run-command:c1', label: 'npm test', text: 'out' },
    ];
    const settled = settleInFlightStreamParts(parts);
    expect(settled[0]).toBe(parts[0]);
    expect(settled[1]).toMatchObject({ toolChainState: 'error', toolStopped: true });
    expect(settled[2]).toBe(parts[2]);
    expect(settled[3]).toMatchObject({ runComplete: true });
  });

  it('returns the same array when nothing is in flight', () => {
    const parts: StreamPart[] = [{ streamTag: 'agent', label: '', text: 'hi' }];
    expect(settleInFlightStreamParts(parts)).toBe(parts);
  });
});

describe('settleLiveTurnMessages', () => {
  it('cancels pending cards and stops running chain rows of the last turn only', () => {
    const earlier = acceptCard('old');
    const messages: ConversationMessage[] = [
      { role: 'user', text: 'first', id: 'u1' },
      earlier,
      { role: 'user', text: 'second', id: 'u2' },
      { role: 'chain', label: 'read', text: '', state: 'running', source: 'tool', statusId: 's1' },
      acceptCard('live'),
    ];
    const settled = settleLiveTurnMessages(messages);
    expect(settled[1]).toBe(earlier);
    expect(settled[3]).toMatchObject({ state: 'error' });
    expect(settled[4]).toMatchObject({ reviewStatus: 'cancelled', reviewSummary: ENDED_TURN_HITL_SUMMARY });
  });

  it('keeps a sub-agent card pending: the sub-agent outlives the turn it showed up in', () => {
    const card = acceptCard('sub', 'child-1');
    const messages: ConversationMessage[] = [{ role: 'user', text: 'go', id: 'u1' }, card];
    expect(settleLiveTurnMessages(messages)).toBe(messages);
  });
});

describe('attachTurnEditedFiles', () => {
  it('sets the files on the reply closing that turn', () => {
    const files = [{ relativePath: 'a.py', op: 'modify' as const, additions: 1, deletions: 0, status: 'kept' as const }];
    const messages: ConversationMessage[] = [
      { role: 'user', text: 'first', id: 'u1' },
      { role: 'assistant', text: 'partial', endedEarly: 'interrupted' },
      { role: 'user', text: 'second', id: 'u2' },
    ];
    const next = attachTurnEditedFiles(messages, 'u1', files);
    expect(next[1]).toMatchObject({ editedFiles: files, endedEarly: 'interrupted' });
    expect(attachTurnEditedFiles(messages, 'u2', files)).toBe(messages);
  });
});

describe('cancelSubagentApprovals', () => {
  it('cancels only the pending cards that sub-agent raised', () => {
    const own = acceptCard('a');
    const other = acceptCard('b', 'child-2');
    const messages = [own, acceptCard('c', 'child-1'), other];
    const next = cancelSubagentApprovals(messages, 'child-1');
    expect(next[0]).toBe(own);
    expect(next[1]).toMatchObject({ reviewStatus: 'cancelled', reviewSummary: SUBAGENT_ENDED_HITL_SUMMARY });
    expect(next[2]).toBe(other);
    expect(cancelSubagentApprovals(messages, 'child-9')).toBe(messages);
  });
});
