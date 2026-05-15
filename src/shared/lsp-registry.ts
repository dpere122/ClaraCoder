/**
 * Integrated workspace LSP configuration (mirrors ``nemo_backend.lsp.file_policy``).
 * Single source for extension → server id and Monaco wiring.
 */

/** Extension (lowercase, with dot) → stable LSP server id. */
export const LSP_EXTENSION_TO_SERVER: Readonly<Record<string, string>> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.gd': 'gdscript',
};

/** Monaco ``languageId`` values that receive workspace LSP providers. */
export const LSP_MONACO_LANGUAGE_IDS: readonly string[] = [
  'python',
  'typescript',
  'javascript',
  'gdscript',
];

/**
 * Server ids used for ``/lsp/semantic-tokens-legend`` prefetch (order matches backend registration).
 */
export const LSP_SEMANTIC_LEGEND_SERVER_IDS: readonly string[] = ['python', 'typescript', 'gdscript'];

/** Subset prefetched on editor mount (avoids GDScript / Godot bridge cold start when no ``.gd`` is open). */
export const LSP_SEMANTIC_LEGEND_PREFETCH_SERVER_IDS: readonly string[] = ['python', 'typescript'];

/** Backward-compatible name for server id strings. */
export type LspServerKind = string;

export function lspServerKindForWorkspaceRelativePath(relativePath: string): LspServerKind | null {
  const n = relativePath.replace(/\\/g, '/').trim();
  if (!n) {
    return null;
  }
  const base = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  return LSP_EXTENSION_TO_SERVER[ext] ?? null;
}

/** Map Monaco language id to semantic-legend / server bucket (JS/TS share ``typescript``). */
export function lspServerIdForMonacoLanguageId(monacoLanguageId: string): string | null {
  const id = (monacoLanguageId || '').toLowerCase();
  if (id === 'python') {
    return 'python';
  }
  if (id === 'typescript' || id === 'javascript') {
    return 'typescript';
  }
  if (id === 'gdscript') {
    return 'gdscript';
  }
  return null;
}

export function isSemanticLegendServerId(server: string): boolean {
  return LSP_SEMANTIC_LEGEND_SERVER_IDS.includes((server || '').trim().toLowerCase());
}
