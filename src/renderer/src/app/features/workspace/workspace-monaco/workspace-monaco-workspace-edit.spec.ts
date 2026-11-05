import type * as Monaco from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import type { LspWireTextEdit } from '@shared/lsp-editor-features';
import { applyTextEditsToString, writeEditsForClosedFiles } from './workspace-monaco-workspace-edit';

function edit(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
  newText: string,
): LspWireTextEdit {
  return { range: { startLineNumber, startColumn, endLineNumber, endColumn }, newText };
}

describe('applyTextEditsToString', () => {
  it('applies several edits against the original coordinates', () => {
    const text = 'func move():\n\tmove()\n';
    expect(applyTextEditsToString(text, [edit(1, 6, 1, 10, 'walk'), edit(2, 2, 2, 6, 'walk')])).toBe(
      'func walk():\n\twalk()\n',
    );
  });

  it('keeps later offsets right when an earlier edit changes the length', () => {
    expect(applyTextEditsToString('a b c', [edit(1, 1, 1, 2, 'longer'), edit(1, 5, 1, 6, 'x')])).toBe('longer b x');
  });

  it('keeps CRLF line endings and counts them as one break', () => {
    expect(applyTextEditsToString('one\r\ntwo\r\n', [edit(2, 1, 2, 4, 'TWO')])).toBe('one\r\nTWO\r\n');
  });

  it('treats a lone CR as a line break, as LSP does', () => {
    expect(applyTextEditsToString('one\rtwo', [edit(2, 1, 2, 4, 'TWO')])).toBe('one\rTWO');
  });

  it('keeps same-position inserts in their original order', () => {
    expect(applyTextEditsToString('x', [edit(1, 1, 1, 1, 'a'), edit(1, 1, 1, 1, 'b')])).toBe('abx');
  });

  it('clamps a position past the end instead of corrupting the text', () => {
    expect(applyTextEditsToString('x', [edit(9, 1, 9, 1, 'y')])).toBe('xy');
  });

  it('counts columns in UTF-16 units', () => {
    expect(applyTextEditsToString('😀 a', [edit(1, 4, 1, 5, 'b')])).toBe('😀 b');
  });
});

describe('writeEditsForClosedFiles', () => {
  const api = (open: string[]) =>
    ({
      Uri: { parse: (value: string) => ({ value }) },
      editor: {
        getModel: (uri: { value: string }) => (open.some((path) => uri.value.endsWith(path)) ? {} : null),
      },
    }) as unknown as typeof Monaco;

  it('writes closed files and hands back the open ones', async () => {
    const electron = {
      readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: 'old' }),
      writeWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
    };
    const openEdits = [edit(1, 1, 1, 1, 'open')];
    const { openChanges, error } = await writeEditsForClosedFiles(api(['open.gd']), electron as never, 'C:/ws', {
      'open.gd': openEdits,
      'closed.gd': [edit(1, 1, 1, 4, 'new')],
    });
    expect(error).toBeUndefined();
    expect(openChanges).toEqual({ 'open.gd': openEdits });
    expect(electron.readWorkspaceFile).toHaveBeenCalledExactlyOnceWith('C:/ws', 'closed.gd');
    expect(electron.writeWorkspaceFile).toHaveBeenCalledExactlyOnceWith('C:/ws', 'closed.gd', 'new');
  });

  it('changes nothing when any closed file cannot be read', async () => {
    const electron = {
      readWorkspaceFile: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, content: 'x' })
        .mockResolvedValueOnce({ ok: false, error: 'gone' }),
      writeWorkspaceFile: vi.fn(),
    };
    const { error } = await writeEditsForClosedFiles(api([]), electron as never, 'C:/ws', {
      'a.gd': [edit(1, 1, 1, 1, 'a')],
      'b.gd': [edit(1, 1, 1, 1, 'b')],
    });
    expect(error).toContain('b.gd');
    expect(electron.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it('reports a failed write', async () => {
    const electron = {
      readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: 'x' }),
      writeWorkspaceFile: vi.fn().mockResolvedValue({ ok: false, error: 'denied' }),
    };
    const { error } = await writeEditsForClosedFiles(api([]), electron as never, 'C:/ws', {
      'a.gd': [edit(1, 1, 1, 1, 'a')],
    });
    expect(error).toContain('denied');
  });
});
