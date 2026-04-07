import type { DiffRow } from '@shared/index';

/** Rebuild file text: equal rows always use baseline; other rows use the right side only if their hunk is accepted. */
export function rebuildFileWithAcceptedHunks(rows: DiffRow[], acceptedHunks: ReadonlySet<number>): string {
  const lines: string[] = [];
  for (const row of rows) {
    const acc = acceptedHunks.has(row.hunkIndex);
    switch (row.kind) {
      case 'equal':
        lines.push(row.leftText);
        break;
      case 'add':
        if (acc) lines.push(row.rightText);
        break;
      case 'remove':
        if (!acc) lines.push(row.leftText);
        break;
      case 'replace':
        lines.push(acc ? row.rightText : row.leftText);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

/** Hunk indices that contain at least one non-equal row, in first-seen order. */
export function changeHunkOrderFromRows(rows: DiffRow[]): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (r.kind !== 'equal' && !seen.has(r.hunkIndex)) {
      seen.add(r.hunkIndex);
      order.push(r.hunkIndex);
    }
  }
  return order;
}
