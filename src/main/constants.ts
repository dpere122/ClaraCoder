/**
 * Main-process constants: Python port, workspace context limits, and dev vs packaged paths.
 * Theme id must stay aligned with THEMES in the renderer theme-selector.
 */
export const DEV_SERVER_URL = process.env.DEV_SERVER_URL;
/**
 * Python sidecar port. Dev (`npm run dev` sets `DEV_SERVER_URL`) uses 5124 so a dev
 * instance can run alongside the installed app's sidecar (5123) without colliding.
 */
export const PYTHON_PORT = DEV_SERVER_URL ? 5124 : 5123;
export const PYTHON_URL = `http://127.0.0.1:${PYTHON_PORT}`;

export const WORKSPACE_CONTEXT_MAX_DEPTH = 6;
export const WORKSPACE_CONTEXT_MAX_ENTRIES = 500;
export const WORKSPACE_WATCH_DEBOUNCE_MS = 500;
export const WORKSPACE_CHANGE_HISTORY_LIMIT = 8;

export const WORKSPACE_CONTEXT_IGNORED_NAMES = new Set([
  '.git',
  '.angular',
  '.cache',
  '.cursor',
  '.idea',
  '.next',
  '.clara',
  '.nemo',
  '.nuxt',
  '.svn',
  '.venv',
  '.vscode',
  '__pycache__',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
  'tmp',
  'vendor',
  'venv',
  // Clara pack artifacts (also in root .gitignore; keep if gitignore matching fails).
  'runtime-bundle',
  'vtsls-bundle',
]);

/** Suffix skips for bulk discovery (log files are always visible — see `isLogRelatedFile`). */
export const WORKSPACE_CONTEXT_IGNORED_SUFFIXES = ['.pyc', '.pyo', '.tmp', '.swp'];

export const WORKSPACE_NODE_MODULES_DIR = 'node_modules';

/** Default theme when none is set (matches renderer `DEFAULT_THEME_ID`). */
export const FIRST_THEME_ID = 'woodland';

/** Allowed app UI theme ids (keep aligned with `THEMES` in theme-selector.ts). */
export const APP_THEME_IDS = ['woodland', 'classical', 'dark-classical'] as const;
