import { promises as fs } from 'fs';
import path = require('path');
import { getWorkspaceDir, getWorkspaceSystemPromptPath } from '../paths';

/** Max bytes accepted when copying a user-selected system prompt file. */
export const WORKSPACE_SYSTEM_PROMPT_MAX_BYTES = 64 * 1024;

export interface WorkspaceSystemPromptStatus {
  hasFile: boolean;
  sourceName: string;
}

export async function readWorkspaceSystemPromptText(workspaceId: string): Promise<string> {
  const wid = (workspaceId || '').trim();
  if (!wid) {
    return '';
  }
  const filePath = getWorkspaceSystemPromptPath(wid);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

export async function getWorkspaceSystemPromptStatus(
  workspaceId: string,
  sourceNameFromConfig?: string,
): Promise<WorkspaceSystemPromptStatus> {
  const wid = (workspaceId || '').trim();
  if (!wid) {
    return { hasFile: false, sourceName: '' };
  }
  const filePath = getWorkspaceSystemPromptPath(wid);
  try {
    await fs.access(filePath);
    const sourceName = (sourceNameFromConfig || '').trim() || path.basename(filePath);
    return { hasFile: true, sourceName };
  } catch {
    return { hasFile: false, sourceName: '' };
  }
}

export async function copyWorkspaceSystemPromptFromPath(
  workspaceId: string,
  sourceAbsolutePath: string,
): Promise<{ sourceName: string }> {
  const wid = (workspaceId || '').trim();
  if (!wid) {
    throw new Error('Workspace id is required.');
  }
  const source = (sourceAbsolutePath || '').trim();
  if (!source || !path.isAbsolute(source)) {
    throw new Error('A valid absolute file path is required.');
  }

  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new Error('Selected file could not be read.');
  }
  if (!stat.isFile()) {
    throw new Error('Selected path is not a file.');
  }
  if (stat.size > WORKSPACE_SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error(`System prompt file must be at most ${WORKSPACE_SYSTEM_PROMPT_MAX_BYTES} bytes.`);
  }

  const content = await fs.readFile(source, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > WORKSPACE_SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error(`System prompt file must be at most ${WORKSPACE_SYSTEM_PROMPT_MAX_BYTES} bytes.`);
  }

  await fs.mkdir(getWorkspaceDir(wid), { recursive: true });
  await fs.writeFile(getWorkspaceSystemPromptPath(wid), content, 'utf8');
  return { sourceName: path.basename(source) };
}

export async function writeWorkspaceSystemPromptText(
  workspaceId: string,
  content: string,
): Promise<void> {
  const wid = (workspaceId || '').trim();
  if (!wid) {
    throw new Error('Workspace id is required.');
  }
  const text = typeof content === 'string' ? content : '';
  if (Buffer.byteLength(text, 'utf8') > WORKSPACE_SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error(`System prompt file must be at most ${WORKSPACE_SYSTEM_PROMPT_MAX_BYTES} bytes.`);
  }
  await fs.mkdir(getWorkspaceDir(wid), { recursive: true });
  await fs.writeFile(getWorkspaceSystemPromptPath(wid), text, 'utf8');
}

export async function clearWorkspaceSystemPromptFile(workspaceId: string): Promise<void> {
  const wid = (workspaceId || '').trim();
  if (!wid) {
    return;
  }
  const filePath = getWorkspaceSystemPromptPath(wid);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }
}
