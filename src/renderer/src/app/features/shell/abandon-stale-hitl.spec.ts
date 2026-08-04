import { abandonStaleHitlMessages, STALE_HITL_SUMMARY } from './abandon-stale-hitl';
import type { ConversationMessage } from '@shared/index';

describe('abandonStaleHitlMessages', () => {
  it('cancels pending HITL artifacts and leaves other messages alone', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', text: 'hi' },
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          rows: [],
          language: 'typescript',
          fullNewContent: 'x',
          truncated: false,
        },
        reviewStatus: 'pending',
      },
      {
        role: 'accept_command',
        payload: {
          version: 1,
          requestId: 'r1',
          kind: 'command',
          title: 't',
          message: 'm',
          confirmLabel: 'Run',
          cancelLabel: 'Cancel',
          commandText: 'c',
          details: ['d'],
        },
        reviewStatus: 'complete',
      },
      {
        role: 'agent_question',
        payload: {
          version: 1,
          requestId: 'q1',
          title: 'Question',
          message: 'Choose one',
          submitLabel: 'Submit',
          cancelLabel: 'Cancel',
          questions: [],
        },
        reviewStatus: 'pending',
      },
    ];
    const next = abandonStaleHitlMessages(messages);
    expect(next).not.toBe(messages);
    expect(next[1]).toEqual(
      expect.objectContaining({
        role: 'diff',
        reviewStatus: 'cancelled',
        reviewSummary: STALE_HITL_SUMMARY,
      }),
    );
    expect(next[2]).toEqual(messages[2]);
    expect(next[3]).toEqual(
      expect.objectContaining({
        role: 'agent_question',
        reviewStatus: 'cancelled',
        reviewSummary: STALE_HITL_SUMMARY,
      }),
    );
  });

  it('returns the same array when nothing is pending', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', text: 'hi' },
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          rows: [],
          language: 'typescript',
          fullNewContent: 'x',
          truncated: false,
        },
        reviewStatus: 'cancelled',
      },
    ];
    expect(abandonStaleHitlMessages(messages)).toBe(messages);
  });
});
