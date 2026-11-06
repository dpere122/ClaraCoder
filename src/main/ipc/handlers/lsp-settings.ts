import { promises as fs } from 'fs';
import * as path from 'path';
import { ipcMain } from 'electron';
import { pyprojectPyrightSection, type PythonProjectConfigInfo } from '../../../shared/lsp-settings';
import { loadConfig } from '../../config/load-save';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

/** Large enough for any real ``pyproject.toml``; stops a huge file from being read into memory. */
const MAX_PYPROJECT_BYTES = 1024 * 1024;

async function readSmallFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_PYPROJECT_BYTES) {
      return null;
    }
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The basedpyright config a workspace folder carries, if any. basedpyright prefers
 * ``pyrightconfig.json`` over ``pyproject.toml`` and ignores a ``pyproject.toml`` with no
 * ``[tool.basedpyright]`` / ``[tool.pyright]`` table.
 */
export async function findPythonProjectConfig(workspaceRoot: string): Promise<PythonProjectConfigInfo | null> {
  const root = workspaceRoot.trim();
  if (!root) {
    return null;
  }
  try {
    if ((await fs.stat(path.join(root, 'pyrightconfig.json'))).isFile()) {
      return { file: 'pyrightconfig.json', section: '' };
    }
  } catch {
    // No pyrightconfig.json; try pyproject.toml.
  }
  const text = await readSmallFile(path.join(root, 'pyproject.toml'));
  const section = text === null ? '' : pyprojectPyrightSection(text);
  return section ? { file: 'pyproject.toml', section } : null;
}

export function registerLspSettingsIpc(): void {
  ipcMain.handle('lsp:python-project-config', async (event) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender', workspacePath: '', config: null };
    }
    try {
      const config = await loadConfig();
      const workspacePath =
        config.workspaces.find((workspace) => workspace.id === config.currentWorkspaceId)?.path?.trim() ?? '';
      return { ok: true as const, workspacePath, config: await findPythonProjectConfig(workspacePath) };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        workspacePath: '',
        config: null,
      };
    }
  });
}
