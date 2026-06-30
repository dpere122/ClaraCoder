import { describe, expect, it } from 'vitest';
import {
  chatContextFileFromEditorSelection,
  chatContextFileKey,
  chatContextFilesEqual,
  formatAttachedFileText,
  formatChatContextChipLabel,
  formatLineRangeLabel,
  type ChatContextFile,
  type EditorSelectionPayload,
} from './chat-context-file';

const baseFile: ChatContextFile = {
  absolutePath: '/ws/src/app.ts',
  relativePath: 'src/app.ts',
  name: 'app.ts',
  kind: 'file',
};

const selectionPayload: EditorSelectionPayload = {
  absolutePath: '/ws/src/app.ts',
  relativePath: 'src/app.ts',
  name: 'app.ts',
  lineRange: { startLine: 12, startColumn: 1, endLine: 45, endColumn: 20 },
  selectedText: 'export class App {}',
};

describe('chatContextFileKey', () => {
  it('uses relative path for whole-file attachments', () => {
    expect(chatContextFileKey(baseFile)).toBe('src/app.ts');
  });

  it('includes line range for editor selections', () => {
    const file = chatContextFileFromEditorSelection(selectionPayload, false);
    expect(chatContextFileKey(file)).toBe('src/app.ts#L12C1-L45C20');
  });

  it('distinguishes whole-file and line-range on the same path', () => {
    const ranged = chatContextFileFromEditorSelection(selectionPayload, true);
    expect(chatContextFileKey(baseFile)).not.toBe(chatContextFileKey(ranged));
  });
});

describe('chatContextFilesEqual', () => {
  it('matches files with the same key', () => {
    const a = chatContextFileFromEditorSelection(selectionPayload, false);
    const b = chatContextFileFromEditorSelection(selectionPayload, true);
    expect(chatContextFilesEqual(a, b)).toBe(true);
  });
});

describe('formatLineRangeLabel', () => {
  it('collapses single-line ranges', () => {
    expect(
      formatLineRangeLabel({ startLine: 7, startColumn: 1, endLine: 7, endColumn: 10 }),
    ).toBe('7');
  });

  it('formats multi-line ranges', () => {
    expect(
      formatLineRangeLabel({ startLine: 12, startColumn: 1, endLine: 45, endColumn: 1 }),
    ).toBe('12–45');
  });
});

describe('formatChatContextChipLabel', () => {
  it('shows basename only for whole-file chips', () => {
    expect(formatChatContextChipLabel(baseFile)).toBe('app.ts');
  });

  it('shows basename and line range for editor chips', () => {
    const file = chatContextFileFromEditorSelection(selectionPayload, false);
    expect(formatChatContextChipLabel(file)).toBe('app.ts · 12–45');
  });
});

describe('formatAttachedFileText', () => {
  it('keeps whole-file attachment text', () => {
    expect(formatAttachedFileText(baseFile)).toBe('Attached file: src/app.ts');
  });

  it('includes read_workspace_file line hints for editor selections', () => {
    const file = chatContextFileFromEditorSelection(selectionPayload, false);
    expect(formatAttachedFileText(file)).toBe(
      'Attached file: src/app.ts (lines 12-45 inclusive; use read_workspace_file with start_line=12, end_line=45)',
    );
  });

  it('includes list_workspace_directory hint for folders', () => {
    const folder: ChatContextFile = {
      absolutePath: '/ws/src/components',
      relativePath: 'src/components',
      name: 'components',
      kind: 'folder',
    };
    expect(formatAttachedFileText(folder)).toBe(
      'Attached folder: src/components (use list_workspace_directory with relative_path="src/components")',
    );
  });
});
