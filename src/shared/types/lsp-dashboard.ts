/** Shape of ``GET /lsp/status`` from the Python backend (`get_lsp_dashboard_status`). */

/** Subprocess lifecycle for one registered language server. */
export type LspLifecyclePhase =
  | 'idle'
  | 'starting'
  | 'initializing'
  | 'indexing'
  | 'running'
  | 'shuttingDown'
  | 'crashed';

export interface LspDashboardServerEntry {
  initialized: boolean;
  phase: LspLifecyclePhase;
  /** Java ``language/status`` type + message, when present. */
  languageStatus?: string | null;
  /** Winning manager scope when workspace and staging both exist. */
  scope?: string;
  /** Latched initialize/process failure text while ``phase`` is ``crashed``. */
  lastError?: string | null;
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
  /** Workspace venv root (dashboard). Analysis uses ``python.pythonPath`` (the interpreter). */
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
