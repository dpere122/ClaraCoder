import { describe, expect, it } from 'vitest';
import { diffLineChangeCounts, formatDiffLineChangeSummary } from '../../shared/diff-stats';
import { hitlTrailItemsFromArtifacts, hitlTrailPanelTitle, hitlTrailRowKindText } from '../../shared/hitl-trail';
import type { DiffRow } from '../../shared/types/diff';

describe('diffLineChangeCounts', () => {
  it('counts add, remove, and replace rows', () => {
    const rows: DiffRow[] = [
      { kind: 'equal', leftLine: 1, rightLine: 1, leftText: 'a', rightText: 'a', hunkIndex: 0 },
      { kind: 'add', leftLine: null, rightLine: 2, leftText: '', rightText: 'b', hunkIndex: 1 },
      { kind: 'remove', leftLine: 3, rightLine: null, leftText: 'c', rightText: '', hunkIndex: 1 },
      { kind: 'replace', leftLine: 4, rightLine: 4, leftText: 'd', rightText: 'e', hunkIndex: 2 },
    ];
    expect(diffLineChangeCounts(rows)).toEqual({ additions: 2, deletions: 2 });
  });
});

describe('formatDiffLineChangeSummary', () => {
  it('formats git-style deltas', () => {
    expect(formatDiffLineChangeSummary({ additions: 12, deletions: 4 })).toBe('+12 −4');
    expect(formatDiffLineChangeSummary({ additions: 0, deletions: 0 })).toBe('0');
  });
});

describe('hitlTrailItemsFromArtifacts', () => {
  it('maps diff artifacts to filename and line summary', () => {
    const rows: DiffRow[] = [
      { kind: 'add', leftLine: null, rightLine: 1, leftText: '', rightText: 'x', hunkIndex: 0 },
      { kind: 'remove', leftLine: 2, rightLine: null, leftText: 'y', rightText: '', hunkIndex: 0 },
    ];
    const items = hitlTrailItemsFromArtifacts([
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'src/foo/bar.ts',
          language: 'typescript',
          rows,
          fullNewContent: 'x',
          truncated: false,
        },
      },
    ]);
    expect(items[0]?.label).toBe('bar.ts');
    expect(items[0]?.lineSummary).toBe('+1 −1');
    expect(hitlTrailRowKindText(items[0]!)).toBe('edit +1 −1');
  });
});

describe('hitlTrailRowKindText', () => {
  it('merges resolved status into the kind pill', () => {
    const items = hitlTrailItemsFromArtifacts([
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [{ kind: 'add', leftLine: null, rightLine: 1, leftText: '', rightText: 'x', hunkIndex: 0 }],
          fullNewContent: 'x',
          truncated: false,
        },
        reviewStatus: 'complete',
      },
    ]);
    expect(hitlTrailRowKindText(items[0]!)).toBe('edit +1 ok');
  });
});

describe('hitlTrailPanelTitle', () => {
  it('shows pending count while live', () => {
    const items = hitlTrailItemsFromArtifacts([
      {
        role: 'diff',
        payload: {
          version: 1,
          relativePath: 'a.ts',
          language: 'typescript',
          rows: [],
          fullNewContent: '',
          truncated: false,
        },
      },
    ]);
    expect(hitlTrailPanelTitle(items, true)).toBe('1 pending');
  });
});
