import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type * as Monaco from 'monaco-editor';
import { Subject } from 'rxjs';
import {
  LSP_MONACO_LANGUAGE_IDS,
  lspServerKindForWorkspaceRelativePath,
  normalizeMonacoWorkspaceEditorSettings,
  type LspEditorDiagnostic,
  type MonacoWorkspaceEditorSettings,
  type WorkspaceFilesChangedMessage,
} from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import {
  absolutePathFromModelKey,
  displayPathForModelKey,
  editorModelKeyForRelativePath,
  isExternalModelKey,
  type OpenEditorFileRef,
  relativePathFromModelKey,
} from '../open-editor-file-ref';
import { registerWorkspaceMonacoLsp, type WorkspaceMonacoLspNavigatePayload } from './workspace-monaco-lsp';
import {
  invalidateMonacoModelLspDocumentSync,
  markMonacoModelLspDocumentSynced,
  monacoModelNeedsLspDocumentSync,
} from './workspace-monaco-lsp-sync-state';

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  gd: 'gdscript',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  vue: 'html',
  svelte: 'html',
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile',
};

/** Monaco language id for a display path (workspace-relative or absolute). */
export function monacoLanguageIdForPath(monacoApi: typeof Monaco, path: string): string {
  const base = path.split('/').pop() ?? path;
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  if (base.toLowerCase() === 'dockerfile') {
    return 'dockerfile';
  }
  const mapped = EXT_TO_LANG[ext];
  if (mapped) {
    return mapped;
  }
  const found = monacoApi.languages.getLanguages().find((l) => l.id === ext);
  return found?.id ?? 'plaintext';
}

/** Model URI for a model key; identical keys always map to the same URI so models are shared. */
export function monacoUriForModelKey(monacoApi: typeof Monaco, modelKey: string): Monaco.Uri {
  const displayPath = displayPathForModelKey(modelKey);
  return isExternalModelKey(modelKey)
    ? monacoApi.Uri.parse(`clara-external:///${encodeURI(absolutePathFromModelKey(modelKey) ?? displayPath)}`)
    : monacoApi.Uri.parse(`clara-workspace:///${encodeURI(relativePathFromModelKey(modelKey) ?? displayPath)}`);
}

export interface DetachedModelInfo {
  tempAbsolutePath: string;
  snapshotAltVersionId: number;
  defaultRelativePath: string;
}

export interface WorkspaceMonacoSaveAsResult {
  oldModelKey: string;
  newModelKey: string;
  relativePath?: string;
  absolutePath?: string;
  outsideWorkspace: boolean;
}

export type WorkspaceMonacoModelEvent =
  | { type: 'reloaded'; modelKey: string }
  | { type: 'detached'; modelKey: string }
  | { type: 'retargeted'; fromKey: string; toKey: string }
  | { type: 'loadError'; modelKey: string; message: string };

export interface GetOrCreateModelResult {
  model: Monaco.editor.ITextModel | null;
  error?: string;
}

/** Owner id for the shell's grid-wide claim (see {@link WorkspaceMonacoModelStore.syncGridOpenFiles}). */
export const EDITOR_GRID_MODEL_OWNER_ID = 'editor-grid';

/**
 * Shared, refcounted Monaco text-model registry.
 *
 * Every `app-workspace-monaco` instance (one per editor-grid slot) is an *owner* of the
 * model keys it displays. A model is created once per key/URI and disposed only when the
 * last owner releases it, so the same file can be open in several slots simultaneously.
 *
 * Also owns cross-instance state that must exist exactly once: dirty / detached /
 * outside-workspace sets, LSP provider registration, hover bridge, diagnostics cache and
 * semantic-token legends.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceMonacoModelStore {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  private monaco: typeof Monaco | null = null;
  private workspaceRoot = '';
  private conversationId: string | null = null;
  private editorSettings: MonacoWorkspaceEditorSettings | null | undefined;
  private buildPlanStreamingKeys: ReadonlySet<string> = new Set();
  private focusedEditor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private lspRegistered = false;
  private lspDisposables: Monaco.IDisposable[] = [];

  private readonly modelByKey = new Map<string, Monaco.editor.ITextModel>();
  private readonly diskSyncedAltVersionByKey = new Map<string, number>();
  private readonly dirtyDisposables = new Map<string, Monaco.IDisposable>();
  private readonly fileRefByKey = new Map<string, OpenEditorFileRef>();
  private readonly detachedByKey = new Map<string, DetachedModelInfo>();
  private readonly ownersByKey = new Map<string, Set<string>>();
  private readonly keysByOwner = new Map<string, Set<string>>();
  /** Cached LSP diagnostics per model key (code actions + Problems tab). */
  readonly diagnosticsByModelKey = new Map<string, LspEditorDiagnostic[]>();
  /** Shared with `registerWorkspaceMonacoLsp` — updated when TS/JS semantic legend is prefetched. */
  readonly semanticLegendsByServer: Record<string, Monaco.languages.SemanticTokensLegend> = {};
  private readonly tsSemanticLegendPrefetchedKeys = new Set<string>();

  /** Model keys whose buffer differs from disk. */
  readonly unsavedKeys = signal<ReadonlySet<string>>(new Set());
  /** Model keys whose on-disk file vanished (buffer kept in a temp snapshot). */
  readonly detachedKeys = signal<ReadonlySet<string>>(new Set());
  /** Model keys for files outside the workspace root. */
  readonly outsideWorkspaceKeys = signal<ReadonlySet<string>>(new Set());

  /** Model lifecycle notifications consumed by editor instances (banners, diagnostics). */
  readonly events$ = new Subject<WorkspaceMonacoModelEvent>();
  /** Emitted after a successful Save As so the shell can retarget tabs. */
  readonly saveAsCompleted$ = new Subject<WorkspaceMonacoSaveAsResult>();
  /** Cross-file navigation requests raised by LSP providers (go-to-definition, code lens). */
  readonly navigateWorkspaceFile$ = new Subject<WorkspaceMonacoLspNavigatePayload>();

  constructor() {
    this.electron.workspaceFilesChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.onWorkspaceFilesChanged(event));
    this.destroyRef.onDestroy(() => {
      for (const d of this.lspDisposables) {
        d.dispose();
      }
      this.lspDisposables = [];
      for (const d of this.dirtyDisposables.values()) {
        d.dispose();
      }
      this.dirtyDisposables.clear();
      for (const m of this.modelByKey.values()) {
        if (!m.isDisposed()) {
          m.dispose();
        }
      }
      this.modelByKey.clear();
    });
  }

  // ---------------------------------------------------------------------------
  // Context shared by all editor instances
  // ---------------------------------------------------------------------------

  get monacoApi(): typeof Monaco | null {
    return this.monaco;
  }

  /** Called by the first editor instance once `monaco-editor` has loaded. */
  setMonaco(api: typeof Monaco): void {
    this.monaco = api;
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root.trim();
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  setConversationId(id: string | null): void {
    this.conversationId = id?.trim() || null;
  }

  /** Conversation id gates LSP; when a workspace is open without chat, IntelliSense stays off. */
  lspSessionId(): string | null {
    return this.conversationId;
  }

  setEditorSettings(settings: MonacoWorkspaceEditorSettings | null | undefined): void {
    this.editorSettings = settings;
  }

  setBuildPlanStreamingKeys(keys: ReadonlySet<string>): void {
    this.buildPlanStreamingKeys = keys;
  }

  /** The editor instance that currently has grid focus; LSP commands (rename, code lens) target it. */
  setFocusedEditor(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
    this.focusedEditor = editor;
  }

  getFocusedEditor(): Monaco.editor.IStandaloneCodeEditor | null {
    return this.focusedEditor;
  }

  clearFocusedEditorIf(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
    if (editor && this.focusedEditor === editor) {
      this.focusedEditor = null;
    }
  }

  // ---------------------------------------------------------------------------
  // LSP registration (once per app)
  // ---------------------------------------------------------------------------

  /** Registers workspace LSP + hover providers exactly once; safe to call from every instance. */
  ensureLspRegistered(monacoApi: typeof Monaco): void {
    if (this.lspRegistered) {
      return;
    }
    this.lspRegistered = true;
    if (this.electron.isElectron) {
      for (const lang of LSP_MONACO_LANGUAGE_IDS) {
        this.lspDisposables.push(
          monacoApi.languages.registerHoverProvider(lang, {
            provideHover: (model, position) => this.provideWorkspaceLspHover(model, position),
          }),
        );
      }
    }
    this.lspDisposables.push(
      registerWorkspaceMonacoLsp({
        monacoApi,
        electron: this.electron,
        getLspSessionId: () => this.lspSessionId(),
        getConversationId: () => this.conversationId,
        getWorkspaceRelativePathForModel: (m) => this.workspaceRelativePathForModel(m),
        getDiagnosticsForModel: (m) => this.diagnosticsForModel(m),
        getEditorTabSettings: () => {
          const { settings } = normalizeMonacoWorkspaceEditorSettings(this.editorSettings ?? undefined);
          return {
            tabSize: settings.tabSize,
            insertSpaces: settings.insertSpaces,
            formatOnSave: settings.formatOnSave,
          };
        },
        getEditor: () => this.focusedEditor,
        onNavigateToWorkspaceFile: (p) => this.navigateWorkspaceFile$.next(p),
        semanticLegendsByServer: this.semanticLegendsByServer,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  getModel(modelKey: string): Monaco.editor.ITextModel | undefined {
    const m = this.modelByKey.get(modelKey);
    return m && !m.isDisposed() ? m : undefined;
  }

  hasModel(modelKey: string): boolean {
    return this.getModel(modelKey) !== undefined;
  }

  modelKeyForModel(model: Monaco.editor.ITextModel): string | undefined {
    for (const [k, m] of this.modelByKey) {
      if (m === model) {
        return k;
      }
    }
    return undefined;
  }

  workspaceRelativePathForModel(model: Monaco.editor.ITextModel): string | undefined {
    const key = this.modelKeyForModel(model);
    return key ? (relativePathFromModelKey(key) ?? undefined) : undefined;
  }

  fileRefForKey(modelKey: string): OpenEditorFileRef | undefined {
    return this.fileRefByKey.get(modelKey);
  }

  isDetachedKey(modelKey: string): boolean {
    return this.detachedByKey.has(modelKey);
  }

  detachedInfo(modelKey: string): DetachedModelInfo | undefined {
    return this.detachedByKey.get(modelKey);
  }

  /** True when the buffer for `modelKey` differs from its last disk-synced version. */
  isKeyDirty(modelKey: string): boolean {
    const model = this.getModel(modelKey);
    const synced = this.diskSyncedAltVersionByKey.get(modelKey);
    return !!(model && synced !== undefined && model.getAlternativeVersionId() !== synced);
  }

  diagnosticsForModel(model: Monaco.editor.ITextModel): readonly LspEditorDiagnostic[] {
    const key = this.modelKeyForModel(model);
    return key ? (this.diagnosticsByModelKey.get(key) ?? []) : [];
  }

  /** Record the current buffer as the disk-synced version (after save / reload). */
  markSyncedToDisk(modelKey: string): void {
    const model = this.getModel(modelKey);
    if (!model) {
      return;
    }
    this.diskSyncedAltVersionByKey.set(modelKey, model.getAlternativeVersionId());
    this.recomputeUnsaved();
  }

  // ---------------------------------------------------------------------------
  // Ownership
  // ---------------------------------------------------------------------------

  /**
   * Declare the set of model keys `ownerId` currently displays. Keys no longer owned by
   * anyone are disposed. Returns the keys that were released by this owner.
   */
  syncOwner(ownerId: string, refs: readonly OpenEditorFileRef[]): string[] {
    const next = new Set<string>();
    for (const ref of refs) {
      if (!ref.modelKey) {
        continue;
      }
      next.add(ref.modelKey);
      this.fileRefByKey.set(ref.modelKey, ref);
      let owners = this.ownersByKey.get(ref.modelKey);
      if (!owners) {
        owners = new Set();
        this.ownersByKey.set(ref.modelKey, owners);
      }
      owners.add(ownerId);
    }
    const prev = this.keysByOwner.get(ownerId) ?? new Set<string>();
    const released: string[] = [];
    for (const key of prev) {
      if (!next.has(key)) {
        released.push(key);
        this.removeOwner(key, ownerId);
      }
    }
    this.keysByOwner.set(ownerId, next);
    this.recomputeOutsideWorkspace();
    this.recomputeDetached();
    this.recomputeUnsaved();
    return released;
  }

  /**
   * Shell-level claim on every text file open anywhere in the editor grid.
   *
   * Per-slot editor instances are transient owners: when a tab moves between slots (or into
   * a freshly split slot whose Monaco instance is still loading) the old slot releases the
   * key before the new one can claim it. Without this claim the refcount would hit zero, the
   * model — and its unsaved edits — would be disposed, and the new slot would reload from disk.
   */
  syncGridOpenFiles(refs: readonly OpenEditorFileRef[]): void {
    this.syncOwner(EDITOR_GRID_MODEL_OWNER_ID, refs);
  }

  /** Release every key held by `ownerId` (instance destroyed). */
  releaseOwner(ownerId: string): void {
    const prev = this.keysByOwner.get(ownerId);
    if (prev) {
      for (const key of prev) {
        this.removeOwner(key, ownerId);
      }
    }
    this.keysByOwner.delete(ownerId);
    this.recomputeOutsideWorkspace();
    this.recomputeDetached();
    this.recomputeUnsaved();
  }

  private removeOwner(modelKey: string, ownerId: string): void {
    const owners = this.ownersByKey.get(modelKey);
    owners?.delete(ownerId);
    if (owners && owners.size > 0) {
      return;
    }
    this.ownersByKey.delete(modelKey);
    this.disposeModel(modelKey);
  }

  private disposeModel(modelKey: string): void {
    this.dirtyDisposables.get(modelKey)?.dispose();
    this.dirtyDisposables.delete(modelKey);
    const model = this.modelByKey.get(modelKey);
    const rel = relativePathFromModelKey(modelKey);
    if (rel && lspServerKindForWorkspaceRelativePath(rel)) {
      const sid = this.lspSessionId();
      if (sid) {
        void this.electron.lspEditorDidClose(sid, rel);
      }
    }
    if (model && !model.isDisposed()) {
      model.dispose();
    }
    this.modelByKey.delete(modelKey);
    this.diskSyncedAltVersionByKey.delete(modelKey);
    this.diagnosticsByModelKey.delete(modelKey);
    void this.cleanupDetachedSnapshot(modelKey);
    this.detachedByKey.delete(modelKey);
    this.fileRefByKey.delete(modelKey);
  }

  // ---------------------------------------------------------------------------
  // Model creation / reload / detach
  // ---------------------------------------------------------------------------

  /** Loads or creates the text model for `modelKey` without attaching it to any editor. */
  async getOrCreateModel(modelKey: string): Promise<GetOrCreateModelResult> {
    const monacoApi = this.monaco;
    const workspaceRoot = this.workspaceRoot;
    if (!monacoApi) {
      return { model: null };
    }
    let model = this.getModel(modelKey);
    if (!model) {
      const ref = this.fileRefByKey.get(modelKey);
      const displayPath = displayPathForModelKey(modelKey);
      let content: string | undefined;
      if (isExternalModelKey(modelKey)) {
        const abs = absolutePathFromModelKey(modelKey) ?? ref?.absolutePath;
        if (!abs) {
          return { model: null, error: 'No external file path.' };
        }
        const res = await this.electron.readAbsoluteFile(abs);
        if (!res.ok || res.content === undefined) {
          return { model: null, error: res.error ?? 'Failed to read file.' };
        }
        content = res.content;
      } else if (this.detachedByKey.has(modelKey)) {
        const d = this.detachedByKey.get(modelKey)!;
        const res = await this.electron.readAbsoluteFile(d.tempAbsolutePath);
        if (!res.ok || res.content === undefined) {
          return { model: null, error: res.error ?? 'Failed to read detached snapshot.' };
        }
        content = res.content;
      } else {
        const rel = relativePathFromModelKey(modelKey);
        if (!rel) {
          return { model: null };
        }
        if (!workspaceRoot) {
          return { model: null };
        }
        const res = await this.electron.readWorkspaceFile(workspaceRoot, rel);
        if (!res.ok || res.content === undefined) {
          return { model: null, error: res.error ?? 'Failed to read file.' };
        }
        content = res.content;
      }
      // Another instance may have created the model while we awaited the read.
      const existing = this.getModel(modelKey);
      if (existing) {
        model = existing;
      } else {
        const uri = monacoUriForModelKey(monacoApi, modelKey);
        const lang = monacoLanguageIdForPath(monacoApi, displayPath);
        const orphan = monacoApi.editor.getModel(uri);
        if (orphan && !orphan.isDisposed()) {
          orphan.setValue(content);
          model = orphan;
        } else {
          model = monacoApi.editor.createModel(content, lang, uri);
        }
        this.modelByKey.set(modelKey, model);
        this.diskSyncedAltVersionByKey.set(modelKey, model.getAlternativeVersionId());
      }
    }
    this.ensureDirtyListener(modelKey, model);
    this.recomputeUnsaved();
    return { model };
  }

  private ensureDirtyListener(key: string, model: Monaco.editor.ITextModel): void {
    if (this.dirtyDisposables.has(key)) {
      return;
    }
    const d = model.onDidChangeContent(() => this.recomputeUnsaved());
    this.dirtyDisposables.set(key, d);
  }

  private onWorkspaceFilesChanged(event: WorkspaceFilesChangedMessage): void {
    const root = this.workspaceRoot;
    if (!root || !this.workspaceRootsEqual(root, event.workspacePath)) {
      return;
    }
    const refreshAll = event.paths.some((p) => {
      const s = normalizePathSlashes(p.trim());
      return s === '.' || s === '';
    });
    const keys = new Set<string>();
    if (refreshAll) {
      for (const k of this.modelByKey.keys()) {
        keys.add(k);
      }
    } else {
      for (const p of event.paths) {
        if (p.startsWith('[staging] ')) {
          continue;
        }
        const relKey = editorModelKeyForRelativePath(normalizePathSlashes(p));
        if (this.modelByKey.has(relKey)) {
          keys.add(relKey);
        }
      }
      for (const k of this.modelByKey.keys()) {
        if (!isExternalModelKey(k) && !this.detachedByKey.has(k)) {
          keys.add(k);
        }
      }
    }
    for (const key of keys) {
      if (isExternalModelKey(key) || this.detachedByKey.has(key)) {
        continue;
      }
      void this.ensureWorkspaceLink(key);
      void this.reloadModelFromDiskIfUnmodified(key);
    }
  }

  private workspaceRootsEqual(a: string, b: string): boolean {
    const x = normalizePathSlashes(a).replace(/\/+$/, '').toLowerCase();
    const y = normalizePathSlashes(b).replace(/\/+$/, '').toLowerCase();
    return x.length > 0 && x === y;
  }

  private async ensureWorkspaceLink(modelKey: string): Promise<void> {
    if (isExternalModelKey(modelKey) || this.detachedByKey.has(modelKey)) {
      return;
    }
    const rel = relativePathFromModelKey(modelKey);
    const root = this.workspaceRoot;
    if (!rel || !root) {
      return;
    }
    const res = await this.electron.workspaceFileExists(root, rel);
    if (!res.ok) {
      return;
    }
    if (!res.exists || !res.isFile) {
      await this.detachModel(modelKey, rel);
    }
  }

  /** Snapshot the buffer to a temp file when the workspace file disappears. */
  async detachModel(modelKey: string, defaultRelativePath: string): Promise<void> {
    if (this.detachedByKey.has(modelKey)) {
      return;
    }
    const model = this.getModel(modelKey);
    if (!model) {
      return;
    }
    const snap = await this.electron.writeEditorDetachedSnapshot(model.getValue());
    if (!snap.ok || !snap.path) {
      this.events$.next({ type: 'loadError', modelKey, message: snap.error ?? 'Failed to snapshot detached file.' });
      return;
    }
    this.detachedByKey.set(modelKey, {
      tempAbsolutePath: snap.path,
      snapshotAltVersionId: model.getAlternativeVersionId(),
      defaultRelativePath,
    });
    this.recomputeDetached();
    this.recomputeUnsaved();
    this.events$.next({ type: 'detached', modelKey });
  }

  private async cleanupDetachedSnapshot(modelKey: string): Promise<void> {
    const d = this.detachedByKey.get(modelKey);
    if (!d) {
      return;
    }
    await this.electron.deleteEditorDetachedSnapshot(d.tempAbsolutePath);
  }

  /** Shell: close tab after discard — remove temp snapshot for a detached key. */
  async cleanupDetachedForKey(modelKey: string): Promise<void> {
    await this.cleanupDetachedSnapshot(modelKey);
    this.detachedByKey.delete(modelKey);
    this.recomputeDetached();
  }

  async reloadModelFromDiskIfUnmodified(modelKey: string): Promise<void> {
    if (this.buildPlanStreamingKeys.has(modelKey)) {
      return;
    }
    const root = this.workspaceRoot;
    const model = this.getModel(modelKey);
    if (!root || !model) {
      return;
    }
    if (isExternalModelKey(modelKey) || this.detachedByKey.has(modelKey)) {
      return;
    }
    const rel = relativePathFromModelKey(modelKey);
    if (!rel) {
      return;
    }
    let baseline = this.diskSyncedAltVersionByKey.get(modelKey);
    if (baseline === undefined) {
      baseline = model.getAlternativeVersionId();
      this.diskSyncedAltVersionByKey.set(modelKey, baseline);
    }
    if (model.getAlternativeVersionId() !== baseline) {
      return;
    }
    const res = await this.electron.readWorkspaceFile(root, rel);
    if (!res.ok || res.content === undefined) {
      await this.detachModel(modelKey, rel);
      return;
    }
    if (model.isDisposed()) {
      return;
    }
    if (model.getValue() !== res.content) {
      model.setValue(res.content);
    }
    this.diskSyncedAltVersionByKey.set(modelKey, model.getAlternativeVersionId());
    invalidateMonacoModelLspDocumentSync(model);
    this.recomputeUnsaved();
    this.events$.next({ type: 'reloaded', modelKey });
  }

  /** Replace buffer content from an external live source (build-plan streaming) and treat it as saved. */
  setModelContentSynced(modelKey: string, content: string): void {
    const model = this.getModel(modelKey);
    if (!model || model.getValue() === content) {
      return;
    }
    model.setValue(content);
    this.diskSyncedAltVersionByKey.set(modelKey, model.getAlternativeVersionId());
    this.recomputeUnsaved();
  }

  // ---------------------------------------------------------------------------
  // Retarget / Save As / Save
  // ---------------------------------------------------------------------------

  retargetModelKey(fromKey: string, toKey: string): void {
    if (fromKey === toKey) {
      return;
    }
    const model = this.getModel(fromKey);
    if (!model) {
      return;
    }
    this.modelByKey.delete(fromKey);
    this.modelByKey.set(toKey, model);
    const synced = this.diskSyncedAltVersionByKey.get(fromKey);
    if (synced !== undefined) {
      this.diskSyncedAltVersionByKey.set(toKey, synced);
      this.diskSyncedAltVersionByKey.delete(fromKey);
    }
    const dirty = this.dirtyDisposables.get(fromKey);
    if (dirty) {
      this.dirtyDisposables.delete(fromKey);
      this.dirtyDisposables.set(toKey, dirty);
    }
    const diags = this.diagnosticsByModelKey.get(fromKey);
    if (diags) {
      this.diagnosticsByModelKey.delete(fromKey);
      this.diagnosticsByModelKey.set(toKey, diags);
    }
    void this.cleanupDetachedSnapshot(fromKey);
    this.detachedByKey.delete(fromKey);
    const owners = this.ownersByKey.get(fromKey);
    if (owners) {
      this.ownersByKey.delete(fromKey);
      this.ownersByKey.set(toKey, owners);
      for (const owner of owners) {
        const keys = this.keysByOwner.get(owner);
        if (keys) {
          keys.delete(fromKey);
          keys.add(toKey);
        }
      }
    }
    const ref = this.fileRefByKey.get(fromKey);
    if (ref) {
      this.fileRefByKey.delete(fromKey);
      const rel = relativePathFromModelKey(toKey);
      const abs = absolutePathFromModelKey(toKey);
      this.fileRefByKey.set(toKey, {
        ...ref,
        modelKey: toKey,
        relativePath: rel ?? undefined,
        absolutePath: abs ?? undefined,
        outsideWorkspace: !!abs,
      });
    }
    this.recomputeDetached();
    this.recomputeOutsideWorkspace();
    this.recomputeUnsaved();
    this.events$.next({ type: 'retargeted', fromKey, toKey });
  }

  /** Save As for a detached/dirty key; returns the new model key when saved. */
  async promptSaveAs(modelKey: string): Promise<string | null> {
    const root = this.workspaceRoot;
    const model = this.getModel(modelKey);
    if (!root || !model) {
      return null;
    }
    const detached = this.detachedByKey.get(modelKey);
    const defaultRel =
      detached?.defaultRelativePath ??
      relativePathFromModelKey(modelKey) ??
      displayPathForModelKey(modelKey);
    const res = await this.electron.promptSaveEditorFile(root, defaultRel, model.getValue());
    if (!res.ok) {
      if (!res.cancelled) {
        this.events$.next({ type: 'loadError', modelKey, message: res.error ?? 'Save failed.' });
      }
      return null;
    }
    await this.cleanupDetachedSnapshot(modelKey);
    this.detachedByKey.delete(modelKey);
    this.recomputeDetached();

    const oldKey = modelKey;
    let newKey = oldKey;
    if (res.outsideWorkspace && res.absolutePath) {
      newKey = `abs:${normalizePathSlashes(res.absolutePath)}`;
    } else if (res.relativePath) {
      newKey = editorModelKeyForRelativePath(res.relativePath);
    }
    if (newKey !== oldKey) {
      this.retargetModelKey(oldKey, newKey);
      this.fileRefByKey.set(newKey, {
        modelKey: newKey,
        relativePath: res.relativePath,
        absolutePath: res.absolutePath,
        outsideWorkspace: !!res.outsideWorkspace,
      });
    }
    this.diskSyncedAltVersionByKey.set(newKey, model.getAlternativeVersionId());
    this.recomputeOutsideWorkspace();
    this.recomputeUnsaved();
    this.saveAsCompleted$.next({
      oldModelKey: oldKey,
      newModelKey: newKey,
      relativePath: res.relativePath,
      absolutePath: res.absolutePath,
      outsideWorkspace: !!res.outsideWorkspace,
    });
    return newKey;
  }

  /** Write the buffer for `modelKey` to disk. Detached keys go through Save As. */
  async saveKey(modelKey: string): Promise<{ ok: boolean; error?: string }> {
    const root = this.workspaceRoot;
    const model = this.getModel(modelKey);
    if (!root || !model) {
      return { ok: false };
    }
    if (this.detachedByKey.has(modelKey)) {
      const newKey = await this.promptSaveAs(modelKey);
      return { ok: !!newKey };
    }
    const content = model.getValue();
    if (isExternalModelKey(modelKey)) {
      const abs = absolutePathFromModelKey(modelKey);
      if (!abs) {
        return { ok: false };
      }
      const res = await this.electron.writeAbsoluteFile(abs, content);
      if (!res.ok) {
        return { ok: false, error: res.error ?? 'Save failed.' };
      }
    } else {
      const rel = relativePathFromModelKey(modelKey);
      if (!rel) {
        return { ok: false };
      }
      const res = await this.electron.writeWorkspaceFile(root, rel, content);
      if (!res.ok) {
        return { ok: false, error: res.error ?? 'Save failed.' };
      }
      const sid = this.lspSessionId();
      if (sid && lspServerKindForWorkspaceRelativePath(rel)) {
        void this.electron.lspEditorDidSave(sid, rel);
      }
    }
    this.diskSyncedAltVersionByKey.set(modelKey, model.getAlternativeVersionId());
    this.recomputeUnsaved();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Semantic legend / hover bridge
  // ---------------------------------------------------------------------------

  async prefetchSemanticLegendForModel(model: Monaco.editor.ITextModel): Promise<void> {
    const lang = model.getLanguageId();
    if (lang !== 'typescript' && lang !== 'javascript') {
      return;
    }
    const convId = this.conversationId;
    if (!this.electron.isElectron || !convId) {
      return;
    }
    const prefetchKey = `${convId}|typescript`;
    if (this.tsSemanticLegendPrefetchedKeys.has(prefetchKey)) {
      return;
    }
    this.tsSemanticLegendPrefetchedKeys.add(prefetchKey);
    const res = await this.electron.lspEditorSemanticTokensLegend(convId, 'typescript');
    this.semanticLegendsByServer['typescript'] = {
      tokenTypes: res.ok ? res.legend.tokenTypes : [],
      tokenModifiers: res.ok ? res.legend.tokenModifiers : [],
    };
  }

  private async provideWorkspaceLspHover(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): Promise<Monaco.languages.Hover | null> {
    const monacoApi = this.monaco;
    if (!this.electron.isElectron || !monacoApi) {
      return null;
    }
    if (model.uri.scheme !== 'clara-workspace') {
      return null;
    }
    const relKey = this.workspaceRelativePathForModel(model);
    if (!relKey || !lspServerKindForWorkspaceRelativePath(relKey)) {
      return null;
    }
    const sessionId = this.conversationId;
    if (!sessionId) {
      return null;
    }
    const skipSync = !monacoModelNeedsLspDocumentSync(model);
    let sentVersion: number | null = skipSync ? null : model.getAlternativeVersionId();
    let res = await this.electron.lspEditorHover(
      sessionId,
      relKey,
      position.lineNumber,
      position.column,
      skipSync ? '' : model.getValue(),
      skipSync,
    );
    // The server does not hold our buffer (restart cleared it, or an agent edit / disk change
    // replaced it). Re-send the live buffer so hover reflects the editor, not disk.
    if (res.ok && res.syncedFromDisk && skipSync) {
      invalidateMonacoModelLspDocumentSync(model);
      sentVersion = model.getAlternativeVersionId();
      res = await this.electron.lspEditorHover(
        sessionId,
        relKey,
        position.lineNumber,
        position.column,
        model.getValue(),
        false,
      );
    }
    if (res.ok && sentVersion !== null) {
      markMonacoModelLspDocumentSynced(model, sentVersion);
    }
    if (!res.ok || !res.markdown?.trim()) {
      return null;
    }
    const hoverRange = res.range
      ? new monacoApi.Range(
          res.range.startLineNumber,
          res.range.startColumn,
          res.range.endLineNumber,
          res.range.endColumn,
        )
      : undefined;
    return {
      contents: [{ value: res.markdown, isTrusted: true }],
      ...(hoverRange ? { range: hoverRange } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Derived sets
  // ---------------------------------------------------------------------------

  private recomputeUnsaved(): void {
    const next = new Set<string>();
    for (const [key, model] of this.modelByKey) {
      if (model.isDisposed()) {
        continue;
      }
      const synced = this.diskSyncedAltVersionByKey.get(key);
      if (synced !== undefined && model.getAlternativeVersionId() !== synced) {
        next.add(key);
      }
    }
    if (!setsEqual(next, this.unsavedKeys())) {
      this.unsavedKeys.set(next);
    }
  }

  private recomputeDetached(): void {
    const next = new Set(this.detachedByKey.keys());
    if (!setsEqual(next, this.detachedKeys())) {
      this.detachedKeys.set(next);
    }
  }

  private recomputeOutsideWorkspace(): void {
    const next = new Set<string>();
    for (const [k, ref] of this.fileRefByKey) {
      if (ref.outsideWorkspace) {
        next.add(k);
      }
    }
    if (!setsEqual(next, this.outsideWorkspaceKeys())) {
      this.outsideWorkspaceKeys.set(next);
    }
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false;
    }
  }
  return true;
}
