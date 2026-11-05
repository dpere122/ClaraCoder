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

export interface LspServersSettings {
  gdscript: GdscriptLspSettings;
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
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Fills missing or malformed fields with defaults, so a hand-edited config can't break the tab. */
export function normalizeLspServersSettings(raw: unknown): LspServersSettings {
  const defaults = defaultLspServersSettings().gdscript;
  const root = raw && typeof raw === 'object' ? (raw as { gdscript?: unknown }) : {};
  const g = (root.gdscript && typeof root.gdscript === 'object' ? root.gdscript : {}) as Partial<
    Record<keyof GdscriptLspSettings, unknown>
  >;
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
    editable: false,
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
