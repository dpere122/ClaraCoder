/** Shape of ``GET /lsp/status`` from the Python backend (`get_lsp_dashboard_status`). */

export interface LspDashboardServerEntry {
  initialized: boolean;
}

export interface LspDashboardStatus {
  sessionId: string;
  workspaceRoot?: string;
  realWorkspaceRoot?: string;
  typescriptProjectRoot?: string | null;
  javaProjectRoot?: string | null;
  activeLspScope?: string;
  cachedDiagnostics?: number;
  diagnosticsCacheNote?: string;
  /** Jedi ``workspace.environmentPath``: venv root used for library hover/docs. */
  pythonEnvironmentPath?: string | null;
  /** Workspace Python interpreter when resolved by env bootstrap. */
  pythonInterpreterPath?: string | null;
  /** ``node_modules`` exists under the resolved TS project root (discovered or last LSP root). */
  nodeModulesPresent?: boolean;
  /** Per registered LSP server; always includes at least ``python`` and ``typescript``. */
  servers: Record<string, LspDashboardServerEntry> & {
    python: LspDashboardServerEntry;
    typescript: LspDashboardServerEntry;
  };
}
