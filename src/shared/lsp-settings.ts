/** Settings → LSP: the integrated language servers and the options saved for them. */

import type { DependencyId } from './types/dependencies';

export type GdscriptDiagnosticsProfile = 'godot' | 'strict' | 'off';

export interface GdscriptLspSettings {
  /** Godot executable for the engine API dump; empty lets gdls look for one. */
  godotBinaryPath: string;
  /**
   * Lets gdls run Godot on a project to read its native add-on classes. That can load the project's
   * native code, so it stays off until someone turns it on.
   */
  allowEngineApiDump: boolean;
  diagnosticsProfile: GdscriptDiagnosticsProfile;
  inlayTypeHints: boolean;
  inlayParameterHints: boolean;
  /** Formatter executable; empty uses ``gdformat`` when it is on ``PATH``. */
  formatterCommand: string;
  /** Formatter arguments, separated by spaces. */
  formatterArgs: string;
}

/** basedpyright's ``typeCheckingMode`` values, loosest first. */
export const PYTHON_TYPE_CHECKING_MODES = ['off', 'basic', 'standard', 'strict', 'recommended', 'all'] as const;
export type PythonTypeCheckingMode = (typeof PYTHON_TYPE_CHECKING_MODES)[number];

export type PythonDiagnosticMode = 'openFilesOnly' | 'workspace';

export interface PythonLspSettings {
  /** A project ``pyrightconfig.json`` or ``[tool.basedpyright]`` / ``[tool.pyright]`` section wins over this. */
  typeCheckingMode: PythonTypeCheckingMode;
  diagnosticMode: PythonDiagnosticMode;
  inlayVariableTypes: boolean;
  inlayCallArgumentNames: boolean;
  inlayFunctionReturnTypes: boolean;
  inlayGenericTypes: boolean;
  autoImportCompletions: boolean;
  /** Extra import roots; relative ones resolve against the workspace folder. */
  extraPaths: string[];
}

export interface LspServersSettings {
  gdscript: GdscriptLspSettings;
  python: PythonLspSettings;
}

export function defaultLspServersSettings(): LspServersSettings {
  return {
    gdscript: {
      godotBinaryPath: '',
      allowEngineApiDump: false,
      diagnosticsProfile: 'godot',
      inlayTypeHints: true,
      inlayParameterHints: true,
      formatterCommand: '',
      formatterArgs: '',
    },
    python: {
      typeCheckingMode: 'standard',
      diagnosticMode: 'openFilesOnly',
      // basedpyright's own inlay hint defaults.
      inlayVariableTypes: true,
      inlayCallArgumentNames: true,
      inlayFunctionReturnTypes: true,
      inlayGenericTypes: false,
      autoImportCompletions: true,
      extraPaths: [],
    },
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function objectOr(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Trimmed, non-empty, de-duplicated path strings; anything else is dropped. */
export function normalizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const path = typeof item === 'string' ? item.trim() : '';
    if (path && !out.includes(path)) {
      out.push(path);
    }
  }
  return out;
}

function normalizePythonLspSettings(raw: unknown): PythonLspSettings {
  const defaults = defaultLspServersSettings().python;
  const p = objectOr(raw) as Partial<Record<keyof PythonLspSettings, unknown>>;
  const mode = p.typeCheckingMode;
  return {
    typeCheckingMode: PYTHON_TYPE_CHECKING_MODES.includes(mode as PythonTypeCheckingMode)
      ? (mode as PythonTypeCheckingMode)
      : defaults.typeCheckingMode,
    diagnosticMode:
      p.diagnosticMode === 'openFilesOnly' || p.diagnosticMode === 'workspace'
        ? p.diagnosticMode
        : defaults.diagnosticMode,
    inlayVariableTypes: booleanOr(p.inlayVariableTypes, defaults.inlayVariableTypes),
    inlayCallArgumentNames: booleanOr(p.inlayCallArgumentNames, defaults.inlayCallArgumentNames),
    inlayFunctionReturnTypes: booleanOr(p.inlayFunctionReturnTypes, defaults.inlayFunctionReturnTypes),
    inlayGenericTypes: booleanOr(p.inlayGenericTypes, defaults.inlayGenericTypes),
    autoImportCompletions: booleanOr(p.autoImportCompletions, defaults.autoImportCompletions),
    extraPaths: normalizePathList(p.extraPaths),
  };
}

/** Fills missing or malformed fields with defaults, so a hand-edited config can't break the tab. */
export function normalizeLspServersSettings(raw: unknown): LspServersSettings {
  const defaults = defaultLspServersSettings().gdscript;
  const root = objectOr(raw);
  const g = objectOr(root['gdscript']) as Partial<Record<keyof GdscriptLspSettings, unknown>>;
  const profile = g.diagnosticsProfile;
  return {
    gdscript: {
      godotBinaryPath: stringOr(g.godotBinaryPath, defaults.godotBinaryPath),
      // Only an explicit true opts in: this one lets a project's native code run.
      allowEngineApiDump: g.allowEngineApiDump === true,
      diagnosticsProfile:
        profile === 'godot' || profile === 'strict' || profile === 'off' ? profile : defaults.diagnosticsProfile,
      inlayTypeHints: booleanOr(g.inlayTypeHints, defaults.inlayTypeHints),
      inlayParameterHints: booleanOr(g.inlayParameterHints, defaults.inlayParameterHints),
      formatterCommand: stringOr(g.formatterCommand, defaults.formatterCommand),
      formatterArgs: stringOr(g.formatterArgs, defaults.formatterArgs),
    },
    python: normalizePythonLspSettings(root['python']),
  };
}

export interface LspServerCatalogEntry {
  /** Stable server id (``lsp-registry``), also the Settings sub-tab id. */
  id: 'gdscript' | 'python' | 'typescript' | 'java';
  label: string;
  /** The language server behind it. */
  server: string;
  languages: string;
  /** The Dependencies entry that installs it; null when it ships with Clara. */
  dependencyId: DependencyId | null;
  /** Has a settings form. The others show a placeholder for now. */
  editable: boolean;
}

/** Every integrated language server, in the order the LSP tab lists them. */
export const LSP_SERVER_CATALOG: readonly LspServerCatalogEntry[] = [
  {
    id: 'gdscript',
    label: 'Godot',
    server: 'gdls',
    languages: 'GDScript (.gd)',
    dependencyId: 'gdls',
    editable: true,
  },
  {
    id: 'python',
    label: 'Python',
    server: 'basedpyright',
    languages: 'Python (.py)',
    dependencyId: null,
    editable: true,
  },
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    server: 'vtsls',
    languages: 'TypeScript and JavaScript (.ts, .tsx, .js, .jsx, .mjs, .cjs)',
    dependencyId: null,
    editable: false,
  },
  {
    id: 'java',
    label: 'Java',
    server: 'Eclipse JDT LS',
    languages: 'Java (.java)',
    dependencyId: 'java-lsp',
    editable: false,
  },
];

/** Where a workspace's own basedpyright config lives, if it has one. */
export interface PythonProjectConfigInfo {
  /** Workspace-relative file, e.g. ``pyrightconfig.json`` or ``pyproject.toml``. */
  file: string;
  /** The ``pyproject.toml`` table that holds it; empty for ``pyrightconfig.json``. */
  section: string;
}

/**
 * Finds the ``[tool.basedpyright]`` or ``[tool.pyright]`` table basedpyright reads from a
 * ``pyproject.toml``. Its own sub-tables (``[tool.pyright.foo]``) count too. Returns '' when there is none.
 */
export function pyprojectPyrightSection(text: string): string {
  const match = /^[ 	]*\[[ 	]*tool\.(basedpyright|pyright)[ 	]*[\].]/m.exec(text);
  return match ? `tool.${match[1]}` : '';
}
