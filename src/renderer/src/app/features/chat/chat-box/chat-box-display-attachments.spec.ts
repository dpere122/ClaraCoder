import { describe, expect, it } from 'vitest';
import {
  attachedFileDisplayLabel,
  attachedFileRefFromText,
  ATTACHED_FILE_PREFIX,
} from '../chat-context-bar/chat-attached-file-display';

describe('attachedFileDisplayLabel', () => {
  it('returns whole-file path unchanged', () => {
    expect(attachedFileDisplayLabel('src/app.ts')).toBe('src/app.ts');
  });

  it('shows basename and line range for editor selection attachments', () => {
    expect(
      attachedFileDisplayLabel(
        'src/app.ts (lines 12-45 inclusive; use read_workspace_file with start_line=12, end_line=45)',
      ),
    ).toBe('app.ts · 12–45');
  });

  it('collapses single-line ranges in display labels', () => {
    expect(
      attachedFileDisplayLabel(
        'src/app.ts (lines 7-7 inclusive; use read_workspace_file with start_line=7, end_line=7)',
      ),
    ).toBe('app.ts · 7');
  });

  it('shows folder name with trailing slash in display labels', () => {
    expect(
      attachedFileDisplayLabel(
        'src/components (use list_workspace_directory with relative_path="src/components")',
      ),
    ).toBe('components/');
  });
});

describe('attachedFileRefFromText', () => {
  it('extracts the attachment body from structured file text', () => {
    const text =
      `${ATTACHED_FILE_PREFIX}src/app.ts (lines 12-45 inclusive; use read_workspace_file with start_line=12, end_line=45)`;
    expect(attachedFileRefFromText(text)).toContain('lines 12-45 inclusive');
  });

  it('extracts the attachment body from structured folder text', () => {
    const text =
      'Attached folder: src/components (use list_workspace_directory with relative_path="src/components")';
    expect(attachedFileRefFromText(text)).toContain('list_workspace_directory');
  });
});
