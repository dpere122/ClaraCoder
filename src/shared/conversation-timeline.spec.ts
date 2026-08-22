import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from './types/conversation';
import type { ConversationFileJournalEntry } from './types/conversation-timeline';
import {
  canRestoreToUserMessage,
  fallbackJournalFromMessages,
  invertJournalEntries,
  journalPreviewPaths,
  journalUserIdsToInvert,
  parseFileJournalSsePayload,
  resolveRestoreUserIndex,
  truncateMessagesAfterUserTurn,
} from './conversation-timeline';

const user = (id: string, text = id): ConversationMessage => ({ role: 'user', id, text });
const assistant = (text: string): ConversationMessage => ({ role: 'assistant', text });

function entry(
  partial: Partial<ConversationFileJournalEntry> & Pick<ConversationFileJournalEntry, 'userMessageId' | 'op' | 'relativePath'>,
): ConversationFileJournalEntry {
  return {
    seq: 0,
    ...partial,
  };
}

describe('conversation timeline', () => {
  const messages: ConversationMessage[] = [
    user('a', 'first'),
    assistant('ok'),
    user('b', 'second'),
    assistant('done'),
  ];

  it('resolves restore by id or raw index', () => {
    expect(resolveRestoreUserIndex(messages, { userMessageId: 'b' })).toBe(2);
    expect(resolveRestoreUserIndex(messages, { userMessageIndex: 0 })).toBe(0);
    expect(resolveRestoreUserIndex(messages, { userMessageIndex: 1 })).toBe(-1);
  });

  it('can restore when later messages exist or the last turn is streaming', () => {
    expect(canRestoreToUserMessage(messages, 0)).toBe(true);
    expect(canRestoreToUserMessage(messages, 2)).toBe(true);
    expect(canRestoreToUserMessage([user('a')], 0)).toBe(false);
    expect(canRestoreToUserMessage([user('a')], 0, { streaming: true })).toBe(true);
  });

  it('truncates the selected user message and everything after it', () => {
    expect(truncateMessagesAfterUserTurn(messages, 2)).toEqual(messages.slice(0, 2));
    expect(truncateMessagesAfterUserTurn(messages, 0)).toEqual([]);
  });

  it('inverts the selected turn and later turns', () => {
    expect([...journalUserIdsToInvert(messages, 0)].sort()).toEqual(['a', 'b']);
    expect([...journalUserIdsToInvert(messages, 2)]).toEqual(['b']);
  });

  it('inverts first mutation per path after the restore point', () => {
    const actions = invertJournalEntries(
      [
        entry({ userMessageId: 'a', seq: 0, op: 'modify', relativePath: 'a.ts', beforeContent: 'A0' }),
        entry({ userMessageId: 'a', seq: 1, op: 'modify', relativePath: 'a.ts', beforeContent: 'A1' }),
        entry({ userMessageId: 'b', seq: 2, op: 'create', relativePath: 'b.ts' }),
        entry({
          userMessageId: 'b',
          seq: 3,
          op: 'copy',
          relativePath: 'src.ts',
          destRelativePath: 'dest.ts',
        }),
      ],
      new Set(['a', 'b']),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        { kind: 'write', relativePath: 'a.ts', content: 'A0', encoding: undefined, newline: undefined },
        { kind: 'delete', relativePath: 'b.ts' },
        { kind: 'delete', relativePath: 'dest.ts' },
      ]),
    );
  });

  it('restores overwritten copy destinations and deleted files', () => {
    const actions = invertJournalEntries(
      [
        entry({
          userMessageId: 'b',
          seq: 0,
          op: 'copy',
          relativePath: 'src.ts',
          destRelativePath: 'dest.ts',
          beforeContent: 'old dest',
        }),
        entry({ userMessageId: 'b', seq: 1, op: 'delete', relativePath: 'gone.ts', beforeContent: 'keep' }),
      ],
      new Set(['b']),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        {
          kind: 'write',
          relativePath: 'dest.ts',
          content: 'old dest',
          encoding: undefined,
          newline: undefined,
        },
        { kind: 'write', relativePath: 'gone.ts', content: 'keep', encoding: undefined, newline: undefined },
      ]),
    );
  });

  it('builds fallback journal from completed diff and staged-transfer cards', () => {
    const hist: ConversationMessage[] = [
      user('a'),
      {
        role: 'diff',
        reviewStatus: 'complete',
        payload: {
          version: 1,
          relativePath: 'x.ts',
          language: 'ts',
          rows: [],
          fullOriginalContent: 'old',
          fullNewContent: 'new',
          truncated: false,
        },
      },
      {
        role: 'staged_transfer_batch',
        reviewStatus: 'complete',
        payload: {
          version: 1,
          requestId: 'r1',
          files: [
            {
              version: 1,
              relativePath: 'y.ts',
              language: 'ts',
              rows: [],
              fullNewContent: 'created',
              truncated: false,
            },
          ],
        },
        fileResolutions: { 'y.ts': 'approved' },
      },
    ];
    const rows = fallbackJournalFromMessages(hist, 0, 'a');
    expect(rows.map((r) => r.relativePath)).toEqual(['x.ts', 'y.ts']);
    expect(rows[0]?.op).toBe('modify');
    expect(rows[1]?.op).toBe('create');
  });

  it('parses file_journal SSE payloads', () => {
    expect(
      parseFileJournalSsePayload({
        userMessageId: 'u1',
        op: 'modify',
        relativePath: 'a.ts',
        beforeContent: 'x',
        beforeNewline: 'lf',
      }),
    ).toMatchObject({ userMessageId: 'u1', op: 'modify', relativePath: 'a.ts', beforeContent: 'x' });
    expect(parseFileJournalSsePayload({ op: 'modify', relativePath: 'a.ts' })).toBeNull();
  });

  it('lists unique preview paths', () => {
    expect(
      journalPreviewPaths([
        { kind: 'delete', relativePath: 'a.ts' },
        { kind: 'write', relativePath: 'a.ts', content: 'x' },
      ]),
    ).toEqual(['a.ts']);
  });
});
