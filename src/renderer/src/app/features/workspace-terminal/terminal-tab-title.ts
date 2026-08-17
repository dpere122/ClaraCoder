/** Last path segment of a cwd, used as the PTY tab label. */
export function folderNameFromCwd(cwd: string): string {
  const raw = cwd.trim();
  if (!raw) {
    return '';
  }
  const trimmed = raw.replace(/[/\\]+$/, '');
  if (!trimmed) {
    return '/';
  }
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return trimmed;
  }
  const parts = trimmed.split(/[/\\]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? trimmed;
}

/** Tab label from cwd; keeps the exited suffix when the shell has already ended. */
export function ptyTabTitleFromCwd(cwd: string, exited = false): string {
  const name = folderNameFromCwd(cwd) || 'Terminal';
  return exited ? `${name} (exited)` : name;
}

export function ptyTabIsExitedTitle(title: string): boolean {
  return / \(exited\)$/.test(title);
}

/** Decode an OSC 7 payload (`file://host/path`) into a filesystem path. */
export function cwdFromOsc7Payload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('file:')) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.trim() || null;
  } catch {
    const m = trimmed.match(/^file:\/\/[^/]*(\/.*)$/);
    if (!m?.[1]) {
      return null;
    }
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
}

const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC7_REMAINDER_MAX = 2_048;

function incompleteOsc7Remainder(tail: string): string {
  const start = tail.lastIndexOf('\x1b]7;');
  if (start >= 0) {
    return tail.slice(start, start + OSC7_REMAINDER_MAX);
  }
  if (tail.endsWith('\x1b]7')) {
    return '\x1b]7';
  }
  if (tail.endsWith('\x1b]')) {
    return '\x1b]';
  }
  if (tail.endsWith('\x1b')) {
    return '\x1b';
  }
  return '';
}

/** Consume a PTY chunk plus any leftover OSC 7 prefix from the previous chunk. */
export function consumeOsc7CwdChunk(
  remainder: string,
  chunk: string,
): { cwd: string | null; remainder: string } {
  const combined = `${remainder}${chunk}`;
  if (!combined.includes('\x1b')) {
    return { cwd: null, remainder: '' };
  }
  OSC7_RE.lastIndex = 0;
  let last: string | null = null;
  let lastCompleteEnd = 0;
  let match: RegExpExecArray | null = OSC7_RE.exec(combined);
  while (match) {
    const cwd = cwdFromOsc7Payload(match[1] ?? '');
    if (cwd) {
      last = cwd;
    }
    lastCompleteEnd = match.index + match[0].length;
    match = OSC7_RE.exec(combined);
  }
  return { cwd: last, remainder: incompleteOsc7Remainder(combined.slice(lastCompleteEnd)) };
}

/** Last OSC 7 cwd in a PTY chunk, if the sequence arrived intact. */
export function extractOsc7CwdFromChunk(chunk: string): string | null {
  return consumeOsc7CwdChunk('', chunk).cwd;
}
