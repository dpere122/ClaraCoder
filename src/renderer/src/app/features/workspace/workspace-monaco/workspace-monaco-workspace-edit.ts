import type * as Monaco from 'monaco-editor';
import type { LspWireRange, LspWireTextEdit } from '@shared/lsp-editor-features';
import type { ElectronService } from '../../../core/electron.service';

export type LspWorkspaceChanges = Record<string, LspWireTextEdit[]>;

/** Offset of the start of every line. LSP line breaks are exactly ``\r\n``, ``\r`` and ``\n``. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10 /* \n */) {
        i++;
      }
      starts.push(i + 1);
    } else if (ch === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Offset of a position. A column past the end of its line means the line's end, as in LSP. */
function offsetOf(starts: readonly number[], text: string, line: number, column: number): number {
  if (line > starts.length) {
    return text.length;
  }
  const index = Math.max(0, line - 1);
  let lineEnd = text.length;
  if (index + 1 < starts.length) {
    lineEnd = starts[index + 1]!;
    if (text.charCodeAt(lineEnd - 1) === 10 /* \n */) {
      lineEnd--;
    }
    if (text.charCodeAt(lineEnd - 1) === 13 /* \r */) {
      lineEnd--;
    }
  }
  return Math.min(lineEnd, starts[index]! + Math.max(0, column - 1));
}

/** Applies edits (1-based Monaco ranges, UTF-16 columns) to ``text``. */
export function applyTextEditsToString(text: string, edits: readonly LspWireTextEdit[]): string {
  const starts = lineStartOffsets(text);
  const spans = edits.map((edit) => ({
    start: offsetOf(starts, text, edit.range.startLineNumber, edit.range.startColumn),
    end: offsetOf(starts, text, edit.range.endLineNumber, edit.range.endColumn),
    newText: edit.newText,
  }));
  // Back to front so earlier offsets stay valid. The sort is stable, so same-position inserts
  // are applied in reverse and end up in their original order.
  const ordered = spans.map((span, index) => ({ span, index }));
  ordered.sort((a, b) => b.span.start - a.span.start || b.index - a.index);
  let out = text;
  for (const { span } of ordered) {
    out = out.slice(0, span.start) + span.newText + out.slice(span.end);
  }
  return out;
}

export function workspaceFileUri(api: typeof Monaco, relativePath: string): Monaco.Uri {
  return api.Uri.parse(`clara-workspace:///${encodeURI(relativePath)}`);
}

function wireToMonacoRange(api: typeof Monaco, r: LspWireRange): Monaco.Range {
  return new api.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn);
}

/** What Node's UTF-8 decoder puts in place of bytes that aren't UTF-8; writing it back loses them. */
const UTF8_REPLACEMENT_CHAR = '\uFFFD';

/**
 * Edits for files that moved: keyed by where each file is now, not where the server saw it.
 * Covers the moved file itself and, for a folder, everything below it.
 */
export function editsAfterMove(
  changes: LspWorkspaceChanges,
  oldRelativePath: string,
  newRelativePath: string,
): LspWorkspaceChanges {
  const moved: LspWorkspaceChanges = {};
  for (const [relativePath, edits] of Object.entries(changes)) {
    const inside = relativePath === oldRelativePath || relativePath.startsWith(`${oldRelativePath}/`);
    moved[inside ? newRelativePath + relativePath.slice(oldRelativePath.length) : relativePath] = edits;
  }
  return moved;
}

/**
 * Writes the edits for files with no tab to disk and returns the rest.
 *
 * ``isOpen`` must mean "a tab can show and save this file". Monaco's bulk edit throws ``bad edit -
 * model not found`` for a file with no model, and a preview model made for a peek widget would
 * silently drop the edit when it is replaced. Every closed file is read and computed before the
 * first write, so a read failure changes nothing.
 */
export async function writeEditsForClosedFiles(
  isOpen: (relativePath: string) => boolean,
  electron: Pick<ElectronService, 'readWorkspaceFile' | 'writeWorkspaceFile'>,
  workspaceRoot: string,
  changes: LspWorkspaceChanges,
): Promise<{ openChanges: LspWorkspaceChanges; error?: string }> {
  const openChanges: LspWorkspaceChanges = {};
  const pending: Array<{ relativePath: string; content: string }> = [];
  for (const [relativePath, edits] of Object.entries(changes)) {
    if (isOpen(relativePath)) {
      openChanges[relativePath] = edits;
      continue;
    }
    const read = await electron.readWorkspaceFile(workspaceRoot, relativePath);
    if (!read.ok || read.content === undefined) {
      return { openChanges: {}, error: `Could not read ${relativePath}: ${read.error ?? 'unknown error'}` };
    }
    if (read.content.includes(UTF8_REPLACEMENT_CHAR)) {
      return { openChanges: {}, error: `Could not edit ${relativePath}: it is not valid UTF-8.` };
    }
    // vtsls leaves a byte order mark out of its first-line columns and gdls counts it, so there is
    // no offset that is right for both; a guess shifts every edit on that line by one.
    if (read.content.charCodeAt(0) === 0xfeff && edits.some((edit) => edit.range.startLineNumber <= 1)) {
      return { openChanges: {}, error: `Could not edit ${relativePath}: it starts with a byte order mark.` };
    }
    pending.push({ relativePath, content: applyTextEditsToString(read.content, edits) });
  }
  for (const { relativePath, content } of pending) {
    const written = await electron.writeWorkspaceFile(workspaceRoot, relativePath, content);
    if (!written.ok) {
      return { openChanges, error: `Could not write ${relativePath}: ${written.error ?? 'unknown error'}` };
    }
  }
  return { openChanges };
}

/** Applies edits to open models; each stays unsaved until the user saves it. */
export function applyEditsToOpenModels(
  api: typeof Monaco,
  changes: LspWorkspaceChanges,
  modelFor: (relativePath: string) => Monaco.editor.ITextModel | undefined,
): void {
  for (const [relativePath, edits] of Object.entries(changes)) {
    modelFor(relativePath)?.pushEditOperations(
      [],
      edits.map((edit) => ({ range: wireToMonacoRange(api, edit.range), text: edit.newText })),
      () => null,
    );
  }
}
