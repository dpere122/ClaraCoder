import { describe, expect, it } from 'vitest';
import { editDiffCounts, parseEditDiff } from './edit-diff';

const DIFF = [
  '--- a/m.py',
  '+++ b/m.py',
  '@@ -1,3 +1,4 @@',
  ' def add(a, b):',
  '-    return a+b',
  '+    return a + b',
  ' ',
  '+def sub(a, b):',
  '@@ -9 +10 @@',
  '-x = 1',
  '+x = 2',
  '\\ Diff cut: 3 more lines',
].join('\n');

describe('parseEditDiff', () => {
  it('numbers old and new lines per hunk and drops file headers', () => {
    expect(parseEditDiff(DIFF)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,4 @@' },
      { kind: 'context', text: 'def add(a, b):', oldNo: 1, newNo: 1 },
      { kind: 'del', text: '    return a+b', oldNo: 2 },
      { kind: 'add', text: '    return a + b', newNo: 2 },
      { kind: 'context', text: '', oldNo: 3, newNo: 3 },
      { kind: 'add', text: 'def sub(a, b):', newNo: 4 },
      { kind: 'hunk', text: '@@ -9 +10 @@' },
      { kind: 'del', text: 'x = 1', oldNo: 9 },
      { kind: 'add', text: 'x = 2', newNo: 10 },
      { kind: 'note', text: 'Diff cut: 3 more lines' },
    ]);
  });

  it('tolerates CRLF and a trailing newline', () => {
    expect(parseEditDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n')).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: 'a', oldNo: 1 },
      { kind: 'add', text: 'b', newNo: 1 },
    ]);
  });

  it('does not read the next file header of a multi-file diff as rows', () => {
    const two = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '--- /dev/null', '+++ b/y', '@@ -0,0 +1 @@', '+c'].join('\n');
    expect(parseEditDiff(two)).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: 'a', oldNo: 1 },
      { kind: 'add', text: 'b', newNo: 1 },
      { kind: 'hunk', text: '@@ -0,0 +1 @@' },
      { kind: 'add', text: 'c', newNo: 1 },
    ]);
    expect(editDiffCounts(two)).toEqual({ additions: 2, deletions: 1 });
  });

  it('a cut marker ends its hunk, so the next file header is not read as rows', () => {
    const cutThenNext = ['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', '-a', '\\ Diff cut: 5 more lines (+3 -2)', '--- /dev/null', '+++ b/y', '@@ -0,0 +1 @@', '+c'].join(
      '\n',
    );
    expect(parseEditDiff(cutThenNext)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'del', text: 'a', oldNo: 1 },
      { kind: 'note', text: 'Diff cut: 5 more lines (+3 -2)' },
      { kind: 'hunk', text: '@@ -0,0 +1 @@' },
      { kind: 'add', text: 'c', newNo: 1 },
    ]);
  });

  it('counts the rows a cut marker stands for', () => {
    expect(editDiffCounts(['@@ -1,9 +1,9 @@', '-a', '+b', '\\ Diff cut: 16 more lines (+8 -8)'].join('\n'))).toEqual({
      additions: 9,
      deletions: 9,
    });
  });

  it('counts added and deleted lines', () => {
    expect(editDiffCounts(DIFF)).toEqual({ additions: 3, deletions: 2 });
    expect(editDiffCounts('')).toEqual({ additions: 0, deletions: 0 });
  });
});
