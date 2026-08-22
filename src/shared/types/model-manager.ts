export type ModelManagerEntryKind = 'file' | 'hubRepo';

export interface ModelManagerFileEntry {
  fileName: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedMs: number;
  source: 'custom' | 'cache';
  sourceRoot?: string;
  suggestedFileName?: string;
  /** Hugging Face hub-style repo folder (`models--*` or blobs/snapshots layout). Omit means a single file. */
  entryKind?: ModelManagerEntryKind;
  /**
   * Snapshot language GGUF inside a hub repo folder when exactly one non-mmproj
   * model file is present. Used so Settings can emit ``-m`` instead of ``-hf``.
   * Projector files named ``*mmproj*`` do not count against this.
   */
  ggufAbsolutePath?: string;
  /**
   * Snapshot multimodal projector GGUF when the hub folder has one (or a preferred
   * pick among several). Auto writes this as ``--mmproj`` on ``-m`` commands.
   */
  mmprojAbsolutePath?: string;
}

export type ModelManagerListModelsResult =
  | { ok: true; models: ModelManagerFileEntry[]; resolvedDir?: string; directoryMissing?: boolean }
  | { ok: false; error: string };

export type ModelManagerMutationResult =
  | { ok: true; model?: ModelManagerFileEntry }
  | { ok: false; error: string };

export interface HuggingFaceModelSearchItem {
  id: string;
  likes: number;
  downloads: number;
  lastModified: string;
  private: boolean;
  gated: boolean;
  tags: string[];
}

export type ModelManagerHfSearchResult =
  | {
      ok: true;
      models: HuggingFaceModelSearchItem[];
      hasMore: boolean;
      skip: number;
      limit: number;
      totalCount: number | null;
      totalPages: number | null;
    }
  | { ok: false; error: string };

/** A single downloadable GGUF file (quant variant) discovered for a Hugging Face repo. */
export interface HuggingFaceModelFile {
  /** Repo-relative file path, e.g. ``model-Q4_K_M.gguf``. */
  fileName: string;
  /** Parsed quantization label, e.g. ``Q4_K_M``; empty when no label is found. */
  quant: string;
  /** File size in bytes when the HF tree API exposed it; null when unknown. */
  sizeBytes: number | null;
}

export type ModelManagerHfFilesResult =
  | { ok: true; files: HuggingFaceModelFile[] }
  | { ok: false; error: string };

/** Stable id for a single HF quant download: ``${repoId}/${fileName}``. */
export type HfDownloadId = string;

/** Phase of an in-flight Hugging Face GGUF download streamed to the renderer. */
export type HfDownloadPhase = 'queued' | 'progress' | 'done' | 'error' | 'cancelled';

/** Progress event for a Hugging Face GGUF download, sent main → renderer. */
export interface HfDownloadProgressEvent {
  /** Stable id matching {@link HfDownloadId}: ``${repoId}/${fileName}``. */
  downloadId: HfDownloadId;
  repoId: string;
  fileName: string;
  phase: HfDownloadPhase;
  /** Bytes written so far; 0 when unknown. */
  receivedBytes: number;
  /** Total file size in bytes when known; null when the server did not report it. */
  totalBytes: number | null;
  /** Absolute path of the finished file (only meaningful for ``done``). */
  absolutePath?: string;
  /** Human-readable error message (only meaningful for ``error``). */
  error?: string;
}

export type ModelManagerDownloadHfResult =
  | { ok: true; absolutePath: string }
  | { ok: false; error: string };
