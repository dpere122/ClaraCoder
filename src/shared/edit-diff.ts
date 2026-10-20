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

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** The backend's note on a diff it cut short: `Diff cut: 1600 more lines (+1590 -10)`. */
const CUT_NOTE = /^Diff cut: \d+ more lines(?: \(\+(\d+) [-−](\d+)\))?/;

/**
 * Rows of the unified diff an edit tool sends with its finished status (`StreamPart.toolDiff`).
 * File headers (`---` / `+++`) are dropped; `\` lines (a cut marker, "No newline at end of file")
 * become notes. A call that wrote several files sends one file diff after another; each hunk's
 * line counts mark where it ends, so the next file's `---` / `+++` header is not read as rows.
 * A cut marker ends its hunk too: the rest of that hunk was dropped.
 */
export function parseEditDiff(diff: string): EditDiffLine[] {
  const rows: EditDiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.replace(/\r?\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newNo = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('\\')) {
      const text = line.replace(/^\\\s?/, '');
      if (CUT_NOTE.test(text)) {
        oldLeft = 0;
        newLeft = 0;
      }
      rows.push({ kind: 'note', text });
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      continue;
    }
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') {
      rows.push({ kind: 'add', text, newNo: newNo++ });
      newLeft -= 1;
    } else if (mark === '-') {
      rows.push({ kind: 'del', text, oldNo: oldNo++ });
      oldLeft -= 1;
    } else if (mark === ' ' || line === '') {
      rows.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  return rows;
}

/** Diff text → counts. Pill labels are recomputed on every streamed delta; the diffs never change. */
const countsCache = new Map<string, DiffLineChangeCounts>();
const COUNTS_CACHE_MAX = 64;

/** Added / deleted line counts of an edit's unified diff, including the rows a cut marker stands for. */
export function editDiffCounts(diff: string): DiffLineChangeCounts {
  const cached = countsCache.get(diff);
  if (cached) {
    return { ...cached };
  }
  let additions = 0;
  let deletions = 0;
  for (const row of parseEditDiff(diff)) {
    if (row.kind === 'add') {
      additions += 1;
    } else if (row.kind === 'del') {
      deletions += 1;
    } else if (row.kind === 'note') {
      const cut = CUT_NOTE.exec(row.text);
      additions += Number(cut?.[1] ?? 0);
      deletions += Number(cut?.[2] ?? 0);
    }
  }
  if (countsCache.size >= COUNTS_CACHE_MAX) {
    countsCache.delete(countsCache.keys().next().value!);
  }
  countsCache.set(diff, { additions, deletions });
  return { additions, deletions };
}
