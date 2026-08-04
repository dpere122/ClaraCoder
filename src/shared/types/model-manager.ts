export type ModelManagerMigrateProgressPhase = 'scanning' | 'copying' | 'finishing' | 'done';

export interface ModelManagerMigrateProgressPayload {
  bytesDone: number;
  bytesTotal: number;
  phase: ModelManagerMigrateProgressPhase;
}

export type ModelManagerEntryKind = 'file' | 'hubRepo';

export interface ModelManagerFileEntry {
  fileName: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedMs: number;
  source: 'custom' | 'cache';
  sourceRoot?: string;
  suggestedFileName?: string;
  /** Hugging Face hub-style repo folder (`models--*` plus blobs/refs/snapshots layout). Omit means a single file. */
  entryKind?: ModelManagerEntryKind;
}

export interface ModelManagerCacheLocation {
  path: string;
  label: string;
  exists: boolean;
}

export type ModelManagerListModelsResult =
  | { ok: true; models: ModelManagerFileEntry[]; resolvedDir?: string; directoryMissing?: boolean }
  | { ok: false; error: string };

export type ModelManagerDetectCachesResult =
  | { ok: true; caches: ModelManagerCacheLocation[] }
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
