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
  | 'error'
  /** Cancel accepted; partial files are being removed. */
  | 'cancelling'
  /** Cancel finished and cleanup ran (``message`` says what was left). */
  | 'cancelled';

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
  /** Sub-dependencies this install drops on disk (packages, binaries, weights). */
  components?: string[];
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
  /** The user cancelled the install; partial files were cleaned up. */
  cancelled?: boolean;
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

/**
 * Static fallback for {@link DependencyInfo.components}; the Python providers report
 * the authoritative list (python-runtime reads it from ``requirements.txt``).
 */
export const DEPENDENCY_COMPONENTS: Record<DependencyId, readonly string[]> = {
  'python-runtime': ['venv', 'pip', 'fastapi', 'uvicorn', 'langchain', 'langgraph', 'openai', 'llama-index', 'fastembed', 'onnxruntime', 'basedpyright', 'black'],
  'llama-server': ['llama-server', 'ggml / llama shared libs', 'cudart DLLs (CUDA builds)'],
  'java-lsp': ['Eclipse JDT LS', 'Equinox launcher', 'JDT plugins'],
  kokoro: ['torch (CPU)', 'kokoro', 'misaki', 'spacy'],
  whisper: ['faster-whisper', 'CTranslate2', 'Whisper model weights'],
};

/** Components to display for a row: provider-reported list, else the static catalog. */
export function dependencyComponents(dep: Pick<DependencyInfo, 'id' | 'components'>): string[] {
  const reported = dep.components?.filter((c) => c && c.trim()) ?? [];
  return reported.length ? reported : [...(DEPENDENCY_COMPONENTS[dep.id] ?? [])];
}

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
    components: [...DEPENDENCY_COMPONENTS[id]],
  }));
}

/** Where a dependency (or one of its pieces) is downloaded from. */
export interface DependencySource {
  label: string;
  /** Upstream project / repository page. */
  url: string;
  /** How Clara pulls it, e.g. "Prebuilt binaries from GitHub releases". */
  detail: string;
}

/**
 * Upstream origin of every managed dependency, mirroring the Python providers in
 * `python/clara_coder_backend/runtime/deps/providers` and `scripts/bundle-portable-python.mjs`.
 * Whisper's model repo depends on the chosen size; see {@link whisperModelSource}.
 */
export const DEPENDENCY_SOURCES: Record<DependencyId, readonly DependencySource[]> = {
  'python-runtime': [
    {
      label: 'CPython (python-build-standalone)',
      url: 'https://github.com/astral-sh/python-build-standalone',
      detail: 'Portable interpreter bundled with packaged builds; the virtualenv is created from it.',
    },
    {
      label: 'Python packages',
      url: 'https://pypi.org/',
      detail: 'Installed with pip from PyPI, as listed in python/requirements.txt.',
    },
  ],
  'llama-server': [
    {
      label: 'llama.cpp',
      url: 'https://github.com/ggml-org/llama.cpp',
      detail: 'Prebuilt binaries from the pinned GitHub release; "Compile from source" builds the same tag.',
    },
  ],
  'java-lsp': [
    {
      label: 'Eclipse JDT Language Server',
      url: 'https://github.com/eclipse-jdtls/eclipse.jdt.ls',
      detail: 'Milestone tarball from download.eclipse.org/jdtls/milestones.',
    },
  ],
  kokoro: [
    {
      label: 'PyTorch (CPU)',
      url: 'https://github.com/pytorch/pytorch',
      detail: 'CPU wheels from download.pytorch.org/whl/cpu.',
    },
    {
      label: 'Kokoro',
      url: 'https://github.com/hexgrad/kokoro',
      detail: 'From PyPI; installed from GitHub when PyPI has no wheel for this Python.',
    },
    {
      label: 'misaki',
      url: 'https://github.com/hexgrad/misaki',
      detail: 'Kokoro dependency; from PyPI, or GitHub alongside Kokoro.',
    },
    {
      label: 'spaCy',
      url: 'https://github.com/explosion/spaCy',
      detail: 'From PyPI.',
    },
    {
      label: 'Kokoro-82M voice model',
      url: 'https://huggingface.co/hexgrad/Kokoro-82M',
      detail: 'Downloaded from Hugging Face by the kokoro library on first use.',
    },
  ],
  whisper: [
    {
      label: 'faster-whisper',
      url: 'https://github.com/SYSTRAN/faster-whisper',
      detail: 'From PyPI.',
    },
    {
      label: 'CTranslate2',
      url: 'https://github.com/OpenNMT/CTranslate2',
      detail: 'Installed from PyPI as a faster-whisper dependency.',
    },
  ],
};

/** Hugging Face repo for a Whisper model size (`Systran/faster-whisper-small`, …). */
export function whisperModelSource(size: string, repoId: string): DependencySource {
  return {
    label: `Whisper ${size} model`,
    url: `https://huggingface.co/${repoId}`,
    detail: `Model weights from Hugging Face (${repoId}).`,
  };
}

/** PyPI page for a package the Python runtime installs (`venv` is part of CPython itself). */
export function pythonPackageUrl(name: string): string | null {
  if (!name || name === 'venv') return null;
  return `https://pypi.org/project/${encodeURIComponent(name)}/`;
}
