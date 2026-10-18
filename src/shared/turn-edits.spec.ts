import { describe, expect, it } from 'vitest';

import { firstJournalEntryPerPath, textLineChangeCounts } from './turn-edits';

describe('textLineChangeCounts', () => {
  it('counts a created / deleted file as all-added / all-removed', () => {
    expect(textLineChangeCounts('', 'a\nb\n')).toEqual({ additions: 2, deletions: 0 });
    expect(textLineChangeCounts('a\nb\nc', '')).toEqual({ additions: 0, deletions: 3 });
  });

  it('counts a replaced line as one addition and one deletion', () => {
    expect(textLineChangeCounts('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ additions: 1, deletions: 1 });
  });

  it('uses an LCS so interleaved inserts are not double-counted', () => {
    expect(textLineChangeCounts('a\nb\nc\n', 'a\nx\nb\ny\nc\n')).toEqual({ additions: 2, deletions: 0 });
  });

  it('ignores CRLF vs LF', () => {
    expect(textLineChangeCounts('a\r\nb\r\n', 'a\nb\n')).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('firstJournalEntryPerPath', () => {
  it('keeps the earliest row per affected path for one turn (copy rows land on the destination)', () => {
    const rows = firstJournalEntryPerPath(
      [
        { userMessageId: 'u1', seq: 2, relativePath: 'a.py', op: 'modify', beforeContent: 'second' },
        { userMessageId: 'u1', seq: 1, relativePath: 'a.py', op: 'modify', beforeContent: 'first' },
        { userMessageId: 'u1', seq: 3, relativePath: 'src.txt', op: 'copy', destRelativePath: 'dst.txt' },
        { userMessageId: 'u2', seq: 0, relativePath: 'a.py', op: 'modify', beforeContent: 'other turn' },
      ],
      'u1',
    );
    expect(rows.map((r) => [r.relativePath, r.beforeContent ?? r.destRelativePath])).toEqual([
      ['a.py', 'first'],
      ['src.txt', 'dst.txt'],
    ]);
  });
});
