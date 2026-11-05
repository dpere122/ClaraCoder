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

function offsetOf(starts: readonly number[], textLength: number, line: number, column: number): number {
  if (line > starts.length) {
    return textLength;
  }
  return Math.min(textLength, starts[Math.max(0, line - 1)]! + Math.max(0, column - 1));
}

/** Applies edits (1-based Monaco ranges, UTF-16 columns) to ``text``. */
export function applyTextEditsToString(text: string, edits: readonly LspWireTextEdit[]): string {
  const starts = lineStartOffsets(text);
  const spans = edits.map((edit) => ({
    start: offsetOf(starts, text.length, edit.range.startLineNumber, edit.range.startColumn),
    end: offsetOf(starts, text.length, edit.range.endLineNumber, edit.range.endColumn),
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

/**
 * Writes the edits for files with no open model to disk and returns the rest.
 *
 * Monaco's bulk edit throws ``bad edit - model not found`` for a file that isn't open, and a model
 * created just for the edit would hold changes no tab can show or save. Every closed file is read
 * and computed before the first write, so a read failure changes nothing.
 */
export async function writeEditsForClosedFiles(
  api: typeof Monaco,
  electron: Pick<ElectronService, 'readWorkspaceFile' | 'writeWorkspaceFile'>,
  workspaceRoot: string,
  changes: LspWorkspaceChanges,
): Promise<{ openChanges: LspWorkspaceChanges; error?: string }> {
  const openChanges: LspWorkspaceChanges = {};
  const pending: Array<{ relativePath: string; content: string }> = [];
  for (const [relativePath, edits] of Object.entries(changes)) {
    if (api.editor.getModel(workspaceFileUri(api, relativePath))) {
      openChanges[relativePath] = edits;
      continue;
    }
    const read = await electron.readWorkspaceFile(workspaceRoot, relativePath);
    if (!read.ok || read.content === undefined) {
      return { openChanges: {}, error: `Could not read ${relativePath}: ${read.error ?? 'unknown error'}` };
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
export function applyEditsToOpenModels(api: typeof Monaco, changes: LspWorkspaceChanges): void {
  for (const [relativePath, edits] of Object.entries(changes)) {
    const model = api.editor.getModel(workspaceFileUri(api, relativePath));
    model?.pushEditOperations(
      [],
      edits.map((edit) => ({ range: wireToMonacoRange(api, edit.range), text: edit.newText })),
      () => null,
    );
  }
}
