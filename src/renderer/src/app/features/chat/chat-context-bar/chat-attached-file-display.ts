import { ATTACHED_FOLDER_PREFIX } from './chat-context-file';

export const ATTACHED_FILE_PREFIX = 'Attached file: ';

const ATTACHED_FILE_LINE_RANGE_RE =
  /^(.+?) \(lines (\d+)-(\d+) inclusive; use read_workspace_file with start_line=\d+, end_line=\d+\)$/;

const ATTACHED_FOLDER_RE =
  /^(.+?) \(use list_workspace_directory with relative_path="(.+?)"\)$/;

/** Display label for a structured attachment text block body (after the prefix). */
export function attachedFileDisplayLabel(textAfterPrefix: string): string {
  const trimmed = textAfterPrefix.trim();
  const folderMatch = ATTACHED_FOLDER_RE.exec(trimmed);
  if (folderMatch) {
    const path = folderMatch[1];
    const name = path.split('/').filter(Boolean).pop() ?? path;
    return name === '.' ? path : `${name}/`;
  }
  const match = ATTACHED_FILE_LINE_RANGE_RE.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const path = match[1];
  const startLine = match[2];
  const endLine = match[3];
  const name = path.split('/').filter(Boolean).pop() ?? path;
  if (startLine === endLine) {
    return `${name} · ${startLine}`;
  }
  return `${name} · ${startLine}–${endLine}`;
}

/** True when the text block is an attached file or folder reference. */
export function isAttachedFileText(text: string): boolean {
  return text.startsWith(ATTACHED_FILE_PREFIX) || text.startsWith(ATTACHED_FOLDER_PREFIX);
}

/** Body of an attached context text block (path or path + tool hint). */
export function attachedFileRefFromText(text: string): string | null {
  if (text.startsWith(ATTACHED_FOLDER_PREFIX)) {
    return text.slice(ATTACHED_FOLDER_PREFIX.length);
  }
  if (text.startsWith(ATTACHED_FILE_PREFIX)) {
    return text.slice(ATTACHED_FILE_PREFIX.length);
  }
  return null;
}
