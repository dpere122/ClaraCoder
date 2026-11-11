import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMain } from 'electron';
import { pyprojectPyrightSection, type JavaJdkCheck, type PythonProjectConfigInfo } from '../../../shared/lsp-settings';
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

/** More Project JDKs than anyone has; stops a bad request from stat'ing without limit. */
const MAX_JDK_PATHS = 64;
const MAX_JDK_PATH_LENGTH = 4096;

function javaBinaryIn(home: string): string {
  return path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

/** ``~`` and ``~/…`` as Python's ``expanduser`` reads them; ``null`` for ``~name``, which it may not find. */
function expandHome(folder: string): string | null {
  if (folder === '~') {
    return os.homedir();
  }
  if (folder.startsWith('~/') || (process.platform === 'win32' && folder.startsWith('~\\'))) {
    return path.join(os.homedir(), folder.slice(2));
  }
  return folder.startsWith('~') ? null : folder;
}

async function missingJavaBinary(home: string): Promise<string | null> {
  const javaBin = javaBinaryIn(home);
  try {
    return (await fs.stat(javaBin)).isFile() ? null : javaBin;
  } catch {
    return javaBin;
  }
}

/**
 * The same folder checks the backend makes before starting JDT LS (``java_server.py``), so
 * Settings can warn before the server refuses to start. JDK folder goes through ``expanduser``
 * there and Project JDKs don't, so only JDK folder expands ``~`` here. The Java version isn't
 * checked: that means running the executable.
 */
export async function checkJavaJdks(jdkHome: string, runtimes: readonly string[]): Promise<JavaJdkCheck> {
  const home = jdkHome.trim();
  let jdkHomeMissing: string | null = null;
  if (home) {
    const expanded = expandHome(home);
    jdkHomeMissing = expanded === null ? javaBinaryIn(home) : await missingJavaBinary(expanded);
  }
  const runtimesMissing = await Promise.all(
    runtimes.map((folder) => (folder.trim() ? missingJavaBinary(folder.trim()) : Promise.resolve(null))),
  );
  return { jdkHome: jdkHomeMissing, runtimes: runtimesMissing };
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_JDK_PATHS &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_JDK_PATH_LENGTH)
  );
}

export function registerLspSettingsIpc(): void {
  ipcMain.handle('lsp:java-check-jdks', async (event, jdkHome: unknown, runtimes: unknown) => {
    try {
      assertTrustedAppRenderer(event);
    } catch {
      return { ok: false as const, error: 'Untrusted IPC sender' };
    }
    if (typeof jdkHome !== 'string' || jdkHome.length > MAX_JDK_PATH_LENGTH || !isPathList(runtimes)) {
      return { ok: false as const, error: 'Invalid JDK folders' };
    }
    return { ok: true as const, check: await checkJavaJdks(jdkHome, runtimes) };
  });

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
