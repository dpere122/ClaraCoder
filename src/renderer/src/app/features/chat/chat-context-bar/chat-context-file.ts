import type { ChatStructuredContentPart } from '@shared/index';

/** Custom drag mime used by the file tree to mark drags that carry an absolute file path. */
export const WORKSPACE_TREE_DRAG_MIME = 'application/x-nemo-workspace-path';

/** Companion mime: `'1'` when the tree drag path is a directory. */
export const WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME = 'application/x-nemo-workspace-path-is-directory';

/** Internal workspace tree moves (files and folders). */
export const WORKSPACE_TREE_INTERNAL_MOVE_MIME = 'application/x-nemo-workspace-internal-move';

/**
 * Populate a drag payload so chat (and other drop targets) accept a workspace path.
 * Do not set {@link WORKSPACE_TREE_INTERNAL_MOVE_MIME} unless the source supports tree moves.
 */
export function populateWorkspacePathDragData(
  dt: DataTransfer,
  absolutePath: string,
  options?: { isDirectory?: boolean; internalMove?: boolean },
): void {
  const isDirectory = options?.isDirectory === true;
  dt.effectAllowed = isDirectory ? 'move' : 'copyMove';
  if (options?.internalMove) {
    dt.setData(WORKSPACE_TREE_INTERNAL_MOVE_MIME, absolutePath);
  }
  dt.setData(WORKSPACE_TREE_DRAG_MIME, absolutePath);
  dt.setData(WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME, isDirectory ? '1' : '0');
  dt.setData('text/plain', absolutePath);
}

/** 1-based inclusive line/column span from the Monaco editor. */
export interface EditorLineRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Payload emitted when the editor selection changes. */
export interface EditorSelectionPayload {
  absolutePath: string;
  relativePath: string;
  name: string;
  lineRange: EditorLineRange;
  selectedText: string;
}

/** A file the user attached to the next chat turn (from the file tree or editor selection). */
export interface ChatContextFile {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Workspace-relative POSIX path (used for the model + image read IPC). */
  relativePath: string;
  /** Basename for display. */
  name: string;
  /** Images are embedded inline for vision; other files are referenced by path. */
  kind: 'image' | 'file' | 'folder';
  /** Present when attached from an editor selection (not whole-file tree attach). */
  lineRange?: EditorLineRange;
  /** True for pinned editor selections; tree attachments are implicitly persistent. */
  pinned?: boolean;
  /** Distinguish tree vs editor origin for UI. */
  source?: 'tree' | 'editor';
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

/** True when the path has a vision-supported image extension. */
export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(lower.slice(dot));
}

/** Stable dedupe/remove key (whole-file vs line-range). */
export function chatContextFileKey(file: ChatContextFile): string {
  const path = file.relativePath.trim();
  if (!file.lineRange) {
    return path;
  }
  const { startLine, startColumn, endLine, endColumn } = file.lineRange;
  return `${path}#L${startLine}C${startColumn}-L${endLine}C${endColumn}`;
}

/** True when two context files refer to the same attachment slot. */
export function chatContextFilesEqual(a: ChatContextFile, b: ChatContextFile): boolean {
  return chatContextFileKey(a) === chatContextFileKey(b);
}

/** Display label for a line range, e.g. "12" or "12–45". */
export function formatLineRangeLabel(range: EditorLineRange): string {
  if (range.startLine === range.endLine) {
    return String(range.startLine);
  }
  return `${range.startLine}–${range.endLine}`;
}

/** Chip label: basename plus optional line range. */
export function formatChatContextChipLabel(file: ChatContextFile): string {
  if (!file.lineRange) {
    return file.name;
  }
  return `${file.name} · ${formatLineRangeLabel(file.lineRange)}`;
}

/** Tooltip title for a context chip. */
export function formatChatContextChipTitle(file: ChatContextFile): string {
  if (!file.lineRange) {
    return file.relativePath;
  }
  const { startLine, startColumn, endLine, endColumn } = file.lineRange;
  return `${file.relativePath} (${startLine}:${startColumn}–${endLine}:${endColumn})`;
}

const ATTACHED_FILE_PREFIX = 'Attached file: ';
export const ATTACHED_IMAGE_PREFIX = 'Attached image: ';
export const ATTACHED_FOLDER_PREFIX = 'Attached folder: ';

/** Normalize workspace-relative path for attachment payloads (`.` at workspace root). */
export function chatContextRelativePathForAttach(relativePath: string): string {
  const trimmed = relativePath.trim();
  return trimmed || '.';
}

/** Structured text block sent to the LLM for a chat-attached image. */
export function formatAttachedImageText(file: ChatContextFile): string {
  const rel = chatContextRelativePathForAttach(file.relativePath);
  return (
    `${ATTACHED_IMAGE_PREFIX}${rel} ` +
    `(use read_workspace_image with relative_path="${rel}" for visual analysis)`
  );
}

/** Structured text block sent to the LLM for a context attachment. */
export function formatAttachedFileText(file: ChatContextFile): string {
  const rel = chatContextRelativePathForAttach(file.relativePath);
  if (file.kind === 'image') {
    return formatAttachedImageText(file);
  }
  if (file.kind === 'folder') {
    return `${ATTACHED_FOLDER_PREFIX}${rel} (use list_workspace_directory with relative_path="${rel}")`;
  }
  if (!file.lineRange) {
    return `${ATTACHED_FILE_PREFIX}${rel}`;
  }
  const { startLine, endLine } = file.lineRange;
  return (
    `${ATTACHED_FILE_PREFIX}${rel} (lines ${startLine}-${endLine} inclusive; ` +
    `use read_workspace_file with start_line=${startLine}, end_line=${endLine})`
  );
}

/** Drop inline image payloads before POST /chat/stream; backend loads workspace images by path. */
export function structuredContentForBackendRequest(
  content: readonly ChatStructuredContentPart[] | undefined,
): readonly ChatStructuredContentPart[] | undefined {
  if (!content?.length) {
    return undefined;
  }
  const blocks = content.filter(
    (part) => String((part as { type?: string }).type ?? '').toLowerCase() !== 'image_url',
  );
  return blocks.length > 0 ? blocks : undefined;
}

/** Build a chat context file from an editor selection payload. */
export function chatContextFileFromEditorSelection(
  payload: EditorSelectionPayload,
  pinned: boolean,
): ChatContextFile {
  return {
    absolutePath: payload.absolutePath,
    relativePath: payload.relativePath,
    name: payload.name,
    kind: 'file',
    lineRange: payload.lineRange,
    pinned,
    source: 'editor',
  };
}
