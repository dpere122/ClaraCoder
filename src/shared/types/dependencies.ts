/**
 * Shared types for the runtime dependency download framework
 * (Python runtime, llama-server, Java LSP, Kokoro, Whisper).
 */

export type DependencyId = 'python-runtime' | 'llama-server' | 'java-lsp' | 'kokoro' | 'whisper';

export type DependencyState = 'missing' | 'installed' | 'updating' | 'error';

export type DependencyProgressPhase =
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'finishing'
  | 'done'
  | 'error';

/**
 * Build variant for the managed llama-server dependency.
 * - `auto`: use the host-detected default (CPU / Vulkan / CUDA prebuilt)
 * - `cpu`: force the CPU build
 * - `vulkan`: force the Vulkan prebuilt (Linux/Windows x64)
 * - `cuda-12`: force the Windows CUDA 12.4 prebuilt (Windows x64)
 * - `cuda-13`: force the Windows CUDA 13.3 prebuilt (Windows x64)
 * - `cuda-compiled`: compile from source with `-DGGML_CUDA=ON` (Linux; needs CUDA toolkit)
 */
export type LlamaServerVariant =
  | 'auto'
  | 'cpu'
  | 'vulkan'
  | 'cuda-12'
  | 'cuda-13'
  | 'cuda-compiled';

export const LLAMA_SERVER_VARIANTS: readonly LlamaServerVariant[] = [
  'auto',
  'cpu',
  'vulkan',
  'cuda-12',
  'cuda-13',
  'cuda-compiled',
] as const;

export const LLAMA_SERVER_VARIANT_LABELS: Record<LlamaServerVariant, string> = {
  auto: 'Auto (detect)',
  cpu: 'CPU',
  vulkan: 'Vulkan (GPU)',
  'cuda-12': 'CUDA 12.4 (Windows)',
  'cuda-13': 'CUDA 13.3 (Windows)',
  'cuda-compiled': 'Compile from source (CUDA)',
};

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
  /** Whisper size ids already on disk under ``{customModelsDir}/whisper`` (Hub cache). */
  downloadedModels?: string[];
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
  'whisper',
] as const;

export const DEPENDENCY_LABELS: Record<DependencyId, string> = {
  'python-runtime': 'Python runtime',
  'llama-server': 'llama-server',
  'java-lsp': 'Java LSP (JDT LS)',
  kokoro: 'Kokoro TTS',
  whisper: 'Whisper STT',
};

export const DEPENDENCY_DESCRIPTIONS: Record<DependencyId, string> = {
  'python-runtime': 'App-managed virtualenv with Clara backend packages.',
  'llama-server': 'llama.cpp server binary for managed local models.',
  'java-lsp': 'Eclipse JDT Language Server for Java diagnostics and navigation.',
  kokoro: 'Local neural TTS (CPU PyTorch + kokoro).',
  whisper: 'Local speech-to-text (faster-whisper, CPU CTranslate2).',
};

export const DEPENDENCY_SIZE_HINTS: Record<DependencyId, string> = {
  'python-runtime': '~150 MB (venv + core packages)',
  'llama-server': '~40–400 MB (CPU ~40 MB; CUDA build + cudart DLLs up to ~400 MB)',
  'java-lsp': '~50–80 MB',
  kokoro: '~1–2 GB (CPU PyTorch + Kokoro)',
  whisper: '~80–500 MB (CTranslate2 + small model)',
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
