/**
 * CommonMark requires a space after the ATX `#` run (`## Title`). Models often emit
 * `##Title` or `###1`, which parsers treat as plain text. Insert that space only on
 * lines that look like headings (outside fenced code blocks).
 */
export function normalizeLooseAtxHeadings(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (inFence) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
        inFence = false;
      }
      out.push(line);
      continue;
    }
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = true;
      out.push(line);
      continue;
    }
    out.push(fixAtxHeadingLine(line));
  }
  return out.join('\n');
}

function fixAtxHeadingLine(line: string): string {
  return line.replace(
    /^(\s{0,3})((?:>\s*)*)(?:([-*+]\s)|(\d+\.\s))?(#{1,6})([^\s#\r\n])/,
    (_full, indent: string, bq: string, ul: string | undefined, ol: string | undefined, hashes: string, next: string) => {
      const list = ul ?? ol ?? '';
      return `${indent}${bq}${list}${hashes} ${next}`;
    },
  );
}
