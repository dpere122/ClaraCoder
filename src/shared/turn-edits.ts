import { journalAffectedPath } from './conversation-timeline';
import type { DiffLineChangeCounts } from './diff-stats';
import type { ConversationFileJournalEntry } from './types/conversation-timeline';

/** Above this many LCS cells, fall back to counting the whole changed middle as removed + added. */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Git-style +/− line counts between two texts (LCS on lines after trimming the common ends). */
export function textLineChangeCounts(before: string, after: string): DiffLineChangeCounts {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) {
    return { additions: m, deletions: n };
  }
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const lineA = a[start + i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = lineA === b[start + j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  const common = prev[m]!;
  return { additions: m - common, deletions: n - common };
}

/** First journal row per affected path for one user turn, in write order. */
export function firstJournalEntryPerPath(
  entries: readonly ConversationFileJournalEntry[],
  userMessageId: string,
): ConversationFileJournalEntry[] {
  const byPath = new Map<string, ConversationFileJournalEntry>();
  const ordered = entries
    .filter((e) => e.userMessageId === userMessageId)
    .slice()
    .sort((x, y) => x.seq - y.seq);
  for (const entry of ordered) {
    const path = journalAffectedPath(entry);
    if (path && !byPath.has(path)) {
      byPath.set(path, entry);
    }
  }
  return [...byPath.values()];
}
