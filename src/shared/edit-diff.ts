import type { DiffLineChangeCounts } from './diff-stats';

/** One rendered row of an edit's unified diff. */
export type EditDiffLineKind = 'hunk' | 'context' | 'add' | 'del' | 'note';

export interface EditDiffLine {
  kind: EditDiffLineKind;
  /** Line text without the `+` / `-` / space marker (hunk rows keep the `@@ … @@` header). */
  text: string;
  /** 1-based line number before the edit (context and deleted lines). */
  oldNo?: number;
  /** 1-based line number after the edit (context and added lines). */
  newNo?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Rows of the unified diff an edit tool sends with its finished status (`StreamPart.toolDiff`).
 * File headers (`---` / `+++`) are dropped; `\` lines (a cut marker, "No newline at end of file")
 * become notes.
 */
export function parseEditDiff(diff: string): EditDiffLine[] {
  const rows: EditDiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.replace(/\r?\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.replace(/^\\\s?/, '') });
      continue;
    }
    if (!inHunk) {
      continue;
    }
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') {
      rows.push({ kind: 'add', text, newNo: newNo++ });
    } else if (mark === '-') {
      rows.push({ kind: 'del', text, oldNo: oldNo++ });
    } else if (mark === ' ' || line === '') {
      rows.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}

/** Added / deleted line counts of an edit's unified diff. */
export function editDiffCounts(diff: string): DiffLineChangeCounts {
  let additions = 0;
  let deletions = 0;
  for (const row of parseEditDiff(diff)) {
    if (row.kind === 'add') {
      additions += 1;
    } else if (row.kind === 'del') {
      deletions += 1;
    }
  }
  return { additions, deletions };
}
