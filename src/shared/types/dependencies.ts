/**
 * Shared types for the runtime dependency download framework
 * (Python runtime, llama-server, Java LSP, Kokoro).
 */

export type DependencyId = 'python-runtime' | 'llama-server' | 'java-lsp' | 'kokoro';

export type DependencyState = 'missing' | 'installed' | 'updating' | 'error';

export type DependencyProgressPhase =
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'finishing'
  | 'done'
  | 'error';

export interface DependencyInfo {
  id: DependencyId;
  label: string;
  description: string;
  version: string | null;
  state: DependencyState;
  /** Installed artifact path, or null when missing. */
  path: string | null;
  /** Human-readable size hint (e.g. "~80 MB"). */
  sizeHint: string;
  /** Whether Delete is allowed for this dependency. */
  canDelete: boolean;
  error?: string | null;
}

export interface DependencyProgressEvent {
  depId: DependencyId;
  phase: DependencyProgressPhase;
  bytesDone?: number;
  bytesTotal?: number;
  message?: string;
}

export interface DependencyActionResult {
  ok: boolean;
  error?: string;
  dependency?: DependencyInfo;
}

export const DEPENDENCY_IDS: readonly DependencyId[] = [
  'python-runtime',
  'llama-server',
  'java-lsp',
  'kokoro',
] as const;

export const DEPENDENCY_LABELS: Record<DependencyId, string> = {
  'python-runtime': 'Python runtime',
  'llama-server': 'llama-server',
  'java-lsp': 'Java LSP (JDT LS)',
  kokoro: 'Kokoro TTS',
};

export const DEPENDENCY_DESCRIPTIONS: Record<DependencyId, string> = {
  'python-runtime': 'App-managed virtualenv with Clara backend packages.',
  'llama-server': 'llama.cpp server binary for managed local models.',
  'java-lsp': 'Eclipse JDT Language Server for Java diagnostics and navigation.',
  kokoro: 'Local neural TTS (CPU PyTorch + kokoro).',
};

export const DEPENDENCY_SIZE_HINTS: Record<DependencyId, string> = {
  'python-runtime': '~150 MB (venv + core packages)',
  'llama-server': '~40–80 MB',
  'java-lsp': '~50–80 MB',
  kokoro: '~1–2 GB (CPU PyTorch + Kokoro)',
};

/** Catalog rows shown when status probing fails (all marked missing). */
export function defaultDependencyCatalog(): DependencyInfo[] {
  return DEPENDENCY_IDS.map((id) => ({
    id,
    label: DEPENDENCY_LABELS[id],
    description: DEPENDENCY_DESCRIPTIONS[id],
    version: null,
    state: 'missing' as const,
    path: null,
    sizeHint: DEPENDENCY_SIZE_HINTS[id],
    canDelete: true,
    error: null,
  }));
}
