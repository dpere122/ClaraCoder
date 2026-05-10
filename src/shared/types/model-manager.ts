export interface ModelManagerFileEntry {
  fileName: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedMs: number;
  source: 'custom' | 'cache';
  sourceRoot?: string;
}

export interface ModelManagerCacheLocation {
  path: string;
  label: string;
  exists: boolean;
}

export type ModelManagerListModelsResult =
  | { ok: true; models: ModelManagerFileEntry[] }
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
  | { ok: true; models: HuggingFaceModelSearchItem[] }
  | { ok: false; error: string };
