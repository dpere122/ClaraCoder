/**
 * Which integrated workspace LSP applies to a path — mirrors
 * ``nemo_backend.lsp.file_policy.lsp_server_for_path`` (Python + TS/JS only).
 */
export type LspServerKind = 'python' | 'typescript';

export function lspServerKindForWorkspaceRelativePath(relativePath: string): LspServerKind | null {
  const n = relativePath.replace(/\\/g, '/').trim();
  if (!n) {
    return null;
  }
  const base = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const map: Record<string, LspServerKind> = {
    '.py': 'python',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'typescript',
    '.jsx': 'typescript',
    '.mjs': 'typescript',
    '.cjs': 'typescript',
  };
  return map[ext] ?? null;
}
