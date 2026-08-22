import { describe, expect, it } from 'vitest';
import {
  canRestoreToUserMessage,
  invertJournalEntries,
  journalUserIdsToInvert,
  parseFileJournalSsePayload,
  resolveRestoreUserIndex,
  truncateMessagesAfterUserTurn,
  type ConversationMessage,
} from '@shared/index';

describe('conversation timeline (renderer)', () => {
  const messages: ConversationMessage[] = [
    { role: 'user', id: 'a', text: 'first' },
    { role: 'assistant', text: 'ok' },
    { role: 'user', id: 'b', text: 'second' },
  ];

  it('resolves, truncates, and inverts the selected user turn', () => {
    expect(resolveRestoreUserIndex(messages, { userMessageId: 'a' })).toBe(0);
    expect(truncateMessagesAfterUserTurn(messages, 0)).toHaveLength(0);
    expect(truncateMessagesAfterUserTurn(messages, 2)).toEqual(messages.slice(0, 2));
    expect(canRestoreToUserMessage(messages, 0)).toBe(true);
    expect([...journalUserIdsToInvert(messages, 0)].sort()).toEqual(['a', 'b']);
    expect(
      invertJournalEntries(
        [
          {
            userMessageId: 'a',
            seq: 0,
            relativePath: 'a.ts',
            op: 'modify',
            beforeContent: 'old',
          },
        ],
        new Set(['a']),
      ),
    ).toEqual([
      { kind: 'write', relativePath: 'a.ts', content: 'old', encoding: undefined, newline: undefined },
    ]);
    expect(parseFileJournalSsePayload({ userMessageId: 'a', op: 'create', relativePath: 'n.ts' })?.op).toBe(
      'create',
    );
  });
});
