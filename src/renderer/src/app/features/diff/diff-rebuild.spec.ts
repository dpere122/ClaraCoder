import { describe, it, expect } from 'vitest';
import type { DiffRow, FileDiffPayload } from '@shared/index';
import {
  firstChangedLineInHunk,
  originalContentForDiffPreview,
  rebuildOriginalFromRows,
} from './diff-rebuild';

function row(partial: Partial<DiffRow> & Pick<DiffRow, 'kind' | 'hunkIndex'>): DiffRow {
  return {
    leftLine: null,
    rightLine: null,
    leftText: '',
    rightText: '',
    ...partial,
  };
}

function payload(rows: DiffRow[], extra: Partial<FileDiffPayload> = {}): FileDiffPayload {
  return {
    version: 1,
    relativePath: 'test.ts',
    language: 'typescript',
    rows,
    fullNewContent: 'new',
    truncated: false,
    ...extra,
  };
}

describe('originalContentForDiffPreview', () => {
  it('prefers fullOriginalContent when present', () => {
    const p = payload([], { fullOriginalContent: 'baseline from snapshot' });
    expect(originalContentForDiffPreview(p)).toBe('baseline from snapshot');
  });

  it('rebuilds from rows skipping add lines', () => {
    const rows: DiffRow[] = [
      row({ kind: 'equal', hunkIndex: 0, leftText: 'a', rightText: 'a', leftLine: 1, rightLine: 1 }),
      row({ kind: 'add', hunkIndex: 0, leftText: '', rightText: 'b', rightLine: 2 }),
      row({ kind: 'remove', hunkIndex: 0, leftText: 'c', rightText: '', leftLine: 3 }),
      row({ kind: 'replace', hunkIndex: 1, leftText: 'old', rightText: 'new', leftLine: 4, rightLine: 4 }),
    ];
    expect(rebuildOriginalFromRows(rows)).toBe('a\nc\nold');
    expect(originalContentForDiffPreview(payload(rows))).toBe('a\nc\nold');
  });
});

describe('firstChangedLineInHunk', () => {
  const rows: DiffRow[] = [
    row({ kind: 'equal', hunkIndex: 0, leftLine: 1, rightLine: 1, leftText: 'x', rightText: 'x' }),
    row({ kind: 'add', hunkIndex: 0, leftLine: null, rightLine: 2, leftText: '', rightText: 'added' }),
    row({ kind: 'remove', hunkIndex: 1, leftLine: 5, rightLine: null, leftText: 'gone', rightText: '' }),
    row({ kind: 'replace', hunkIndex: 1, leftLine: 6, rightLine: 6, leftText: 'a', rightText: 'b' }),
  ];

  it('returns first non-equal line on modified side', () => {
    expect(firstChangedLineInHunk(payload(rows), 0, 'modified')).toBe(2);
    expect(firstChangedLineInHunk(payload(rows), 1, 'modified')).toBe(6);
  });

  it('returns first non-equal line on original side', () => {
    expect(firstChangedLineInHunk(payload(rows), 1, 'original')).toBe(5);
  });

  it('falls back to 1 when hunk has no line numbers', () => {
    const bare = [row({ kind: 'add', hunkIndex: 9, leftText: '', rightText: 'x' })];
    expect(firstChangedLineInHunk(payload(bare), 9, 'modified')).toBe(1);
  });
});
