import { describe, expect, it, vi } from 'vitest';
import type { LspWireTextEdit } from '@shared/lsp-editor-features';
import { applyTextEditsToString, editsAfterMove, writeEditsForClosedFiles } from './workspace-monaco-workspace-edit';

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

  it('treats a column past the end of a line as its end, not the next line', () => {
    expect(applyTextEditsToString('ab\ncd\n', [edit(1, 1, 1, 99, 'x')])).toBe('x\ncd\n');
    expect(applyTextEditsToString('ab\r\ncd', [edit(1, 3, 1, 99, 'x')])).toBe('abx\r\ncd');
    expect(applyTextEditsToString('ab\rcd', [edit(1, 1, 1, 99, 'x')])).toBe('x\rcd');
    expect(applyTextEditsToString('ab\ncd', [edit(2, 2, 2, 99, 'x')])).toBe('ab\ncx');
  });

  it('leaves a blank line alone when an edit sits at its end', () => {
    expect(applyTextEditsToString('\n\nx', [edit(1, 5, 1, 5, 'y')])).toBe('y\n\nx');
  });

  it('counts columns in UTF-16 units', () => {
    expect(applyTextEditsToString('😀 a', [edit(1, 4, 1, 5, 'b')])).toBe('😀 b');
  });
});

describe('editsAfterMove', () => {
  const edits = [edit(1, 1, 1, 1, 'x')];

  it('rekeys the moved file and leaves other files alone', () => {
    expect(editsAfterMove({ 'a/old.gd': edits, 'b.gd': edits }, 'a/old.gd', 'a/new.gd')).toEqual({
      'a/new.gd': edits,
      'b.gd': edits,
    });
  });

  it('rekeys files below a moved folder, not ones that only share its prefix', () => {
    expect(editsAfterMove({ 'a/x.gd': edits, 'ab/x.gd': edits }, 'a', 'c')).toEqual({
      'c/x.gd': edits,
      'ab/x.gd': edits,
    });
  });
});

describe('writeEditsForClosedFiles', () => {
  const isOpenIn = (open: string[]) => (relativePath: string) => open.includes(relativePath);

  it('writes closed files and hands back the open ones', async () => {
    const electron = {
      readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: 'old' }),
      writeWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
    };
    const openEdits = [edit(1, 1, 1, 1, 'open')];
    const { openChanges, error } = await writeEditsForClosedFiles(isOpenIn(['open.gd']), electron as never, 'C:/ws', {
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
    const { error } = await writeEditsForClosedFiles(isOpenIn([]), electron as never, 'C:/ws', {
      'a.gd': [edit(1, 1, 1, 1, 'a')],
      'b.gd': [edit(1, 1, 1, 1, 'b')],
    });
    expect(error).toContain('b.gd');
    expect(electron.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it('refuses a file that is not UTF-8 rather than writing replacement characters over it', async () => {
    const electron = {
      readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: 'caf\uFFFD = 1' }),
      writeWorkspaceFile: vi.fn(),
    };
    const { error } = await writeEditsForClosedFiles(isOpenIn([]), electron as never, 'C:/ws', {
      'latin1.py': [edit(1, 1, 1, 4, 'x')],
    });
    expect(error).toContain('latin1.py');
    expect(electron.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it('refuses first-line edits in a file with a byte order mark rather than guess its columns', async () => {
    const electron = {
      readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: '\uFEFFimport { bar } from "./a";\nbar();\n' }),
      writeWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { error } = await writeEditsForClosedFiles(isOpenIn([]), electron as never, 'C:/ws', {
      'bom.ts': [edit(1, 10, 1, 13, 'baz')],
    });
    expect(error).toContain('bom.ts');
    expect(electron.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it('edits the later lines of a file with a byte order mark and keeps the mark', async () => {
    const electron = {
      readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: '\uFEFF// head\nbar();\n' }),
      writeWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { error } = await writeEditsForClosedFiles(isOpenIn([]), electron as never, 'C:/ws', {
      'bom.ts': [edit(2, 1, 2, 4, 'baz')],
    });
    expect(error).toBeUndefined();
    expect(electron.writeWorkspaceFile).toHaveBeenCalledExactlyOnceWith('C:/ws', 'bom.ts', '\uFEFF// head\nbaz();\n');
  });

  it('reports a failed write', async () => {
    const electron = {
      readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: 'x' }),
      writeWorkspaceFile: vi.fn().mockResolvedValue({ ok: false, error: 'denied' }),
    };
    const { error } = await writeEditsForClosedFiles(isOpenIn([]), electron as never, 'C:/ws', {
      'a.gd': [edit(1, 1, 1, 1, 'a')],
    });
    expect(error).toContain('denied');
  });
});
