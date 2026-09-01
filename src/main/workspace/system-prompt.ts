import { promises as fs } from 'fs';
import path = require('path');
import {
  LEGACY_WORKSPACE_META_DIR,
  WORKSPACE_SYSTEM_PROMPT_FILE,
  WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
} from '../../shared';
import { getLegacyAppDataSystemPromptPath, getWorkspaceSystemPromptPath } from '../paths';
import { migrateLegacyWorkspaceMetaDir } from './meta-dir';

/** Default system prompt written into every workspace so the prompt file always exists. */
export const DEFAULT_WORKSPACE_SYSTEM_PROMPT = `You are Clara, a senior software engineering agent operating inside the Clara Coder IDE.

You work iteratively: read the workspace, plan, make focused edits, run commands, and verify. Prefer small, reviewable changes. Explain trade-offs briefly, then act. Use the provided tools rather than asking the user to do things by hand.

Be direct and concise. When you are unsure about intent, ask a short clarifying question before making changes.
`;

export interface EnsuredWorkspaceSystemPromptFile {
  absolutePath: string;
  relativePath: string;
  created: boolean;
}

export async function readWorkspaceSystemPromptText(workspaceRoot: string): Promise<string> {
  const root = (workspaceRoot || '').trim();
  if (!root) {
    return '';
  }
  const filePath = getWorkspaceSystemPromptPath(root);
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

/**
 * Ensure `{workspace}/.clara/system-prompt.md` exists.
 * Seeds from leftover `.nemo/system-prompt.md`, then app-data, then the default.
 */
export async function ensureWorkspaceSystemPrompt(
  workspaceRoot: string,
  workspaceId?: string,
): Promise<EnsuredWorkspaceSystemPromptFile> {
  const root = (workspaceRoot || '').trim();
  if (!root) {
    throw new Error('Workspace path is required.');
  }
  await migrateLegacyWorkspaceMetaDir(root);
  const dest = getWorkspaceSystemPromptPath(root);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.access(dest);
    return {
      absolutePath: dest,
      relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
      created: false,
    };
  } catch {
    /* missing — seed below */
  }

  const legacyDest = path.join(root, LEGACY_WORKSPACE_META_DIR, WORKSPACE_SYSTEM_PROMPT_FILE);
  try {
    const legacyText = await fs.readFile(legacyDest, 'utf8');
    await fs.writeFile(dest, legacyText, 'utf8');
    return {
      absolutePath: dest,
      relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
      created: true,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  const wid = (workspaceId || '').trim();
  if (wid) {
    try {
      const legacyText = await fs.readFile(getLegacyAppDataSystemPromptPath(wid), 'utf8');
      await fs.writeFile(dest, legacyText, 'utf8');
      return {
        absolutePath: dest,
        relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
        created: true,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
  }

  await fs.writeFile(dest, DEFAULT_WORKSPACE_SYSTEM_PROMPT, 'utf8');
  return {
    absolutePath: dest,
    relativePath: WORKSPACE_SYSTEM_PROMPT_RELATIVE_PATH,
    created: true,
  };
}
