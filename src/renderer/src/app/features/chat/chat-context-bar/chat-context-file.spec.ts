import { describe, expect, it } from 'vitest';
import {
  chatContextFileFromEditorSelection,
  chatContextFileKey,
  chatContextFilesEqual,
  formatAttachedFileText,
  formatAttachedImageText,
  populateWorkspacePathDragData,
  structuredContentForBackendRequest,
  formatChatContextChipLabel,
  formatLineRangeLabel,
  WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME,
  WORKSPACE_TREE_DRAG_MIME,
  WORKSPACE_TREE_INTERNAL_MOVE_MIME,
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

describe('populateWorkspacePathDragData', () => {
  it('sets chat-accepted workspace path mimes for a file drag', () => {
    const data = new Map<string, string>();
    const dt = {
      effectAllowed: 'none' as DataTransfer['effectAllowed'],
      setData: (type: string, value: string) => {
        data.set(type, value);
      },
    } as unknown as DataTransfer;

    populateWorkspacePathDragData(dt, '/ws/photos/a.png');

    expect(dt.effectAllowed).toBe('copyMove');
    expect(data.get(WORKSPACE_TREE_DRAG_MIME)).toBe('/ws/photos/a.png');
    expect(data.get(WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME)).toBe('0');
    expect(data.get('text/plain')).toBe('/ws/photos/a.png');
    expect(data.has(WORKSPACE_TREE_INTERNAL_MOVE_MIME)).toBe(false);
  });

  it('marks directories and optional internal tree moves', () => {
    const data = new Map<string, string>();
    const dt = {
      effectAllowed: 'none' as DataTransfer['effectAllowed'],
      setData: (type: string, value: string) => {
        data.set(type, value);
      },
    } as unknown as DataTransfer;

    populateWorkspacePathDragData(dt, '/ws/photos', { isDirectory: true, internalMove: true });

    expect(dt.effectAllowed).toBe('move');
    expect(data.get(WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME)).toBe('1');
    expect(data.get(WORKSPACE_TREE_INTERNAL_MOVE_MIME)).toBe('/ws/photos');
  });
});

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

describe('formatAttachedImageText', () => {
  it('includes read_workspace_image hint for image attachments', () => {
    const image: ChatContextFile = {
      absolutePath: '/ws/assets/logo.png',
      relativePath: 'assets/logo.png',
      name: 'logo.png',
      kind: 'image',
    };
    expect(formatAttachedImageText(image)).toBe(
      'Attached image: assets/logo.png (use read_workspace_image with relative_path="assets/logo.png" for visual analysis)',
    );
  });
});

describe('structuredContentForBackendRequest', () => {
  it('removes image_url blocks but keeps attachment hints', () => {
    const content = [
      { type: 'text', text: 'Attached image: logo.png (use read_workspace_image...)' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ];
    expect(structuredContentForBackendRequest(content)).toEqual([
      { type: 'text', text: 'Attached image: logo.png (use read_workspace_image...)' },
    ]);
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
