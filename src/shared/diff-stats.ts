import type { DiffRow } from './types/diff';

export interface DiffLineChangeCounts {
  additions: number;
  deletions: number;
}

/** Count line-level additions and deletions from side-by-side diff rows. */
export function diffLineChangeCounts(rows: readonly DiffRow[]): DiffLineChangeCounts {
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    if (row.kind === 'add') {
      additions += 1;
    } else if (row.kind === 'remove') {
      deletions += 1;
    } else if (row.kind === 'replace') {
      additions += 1;
      deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Compact git-style summary, e.g. "+12 −4" or "0". */
export function formatDiffLineChangeSummary(counts: DiffLineChangeCounts): string {
  if (counts.additions === 0 && counts.deletions === 0) {
    return '0';
  }
  const parts: string[] = [];
  if (counts.additions > 0) {
    parts.push(`+${counts.additions}`);
  }
  if (counts.deletions > 0) {
    parts.push(`−${counts.deletions}`);
  }
  return parts.join(' ');
}
