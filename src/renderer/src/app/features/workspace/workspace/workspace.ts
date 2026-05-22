import { Component, computed, effect, HostListener, input, OnDestroy, output, signal, untracked, ViewEncapsulation } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import type { PythonInterpreterListItem, Workspace } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { Subscription } from 'rxjs';
import { EditorLspStatusComponent } from '../../shell/editor-lsp-status/editor-lsp-status';
import { ThemeSelector } from '../../layout/theme-selector/theme-selector';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';

type WorkspaceChangeKind = 'created' | 'updated' | 'deleted' | 'renamed' | 'unknown';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  expanded: boolean;
  children: FileNode[] | null;
  depth: number;
}

interface FlatNode {
  name: string;
  path: string;
  isDirectory: boolean;
  expanded: boolean;
  depth: number;
  hasChildren: boolean;
}

@Component({
  selector: 'app-workspace',
  imports: [LucideAngularModule, ThemeSelector, EditorLspStatusComponent],
  templateUrl: './workspace.html',
  styleUrl: './workspace.css',
  encapsulation: ViewEncapsulation.None,
})
export class WorkspaceComponent implements OnDestroy {
  readonly workspaces = input<Workspace[]>([]);
  readonly currentWorkspaceId = input<string | null>(null);
  /** Active chat session id — Python LSP / interpreter APIs key off this. */
  readonly activeConversationId = input<string | null>(null);
  /** Active editor tab path (workspace-relative); drives which integrated LSP is warmed and shown. */
  readonly activeFileRelativePath = input<string | null>(null);

  readonly workspaceChanged = output<string | null>();
  readonly addWorkspace = output<void>();
  /** User double-clicked a file in the tree (absolute path on disk). */
  readonly workspaceFileOpen = output<{ absolutePath: string }>();

  protected readonly flatTree = signal<FlatNode[]>([]);
  protected readonly loadError = signal('');
  protected readonly lastWorkspaceChange = signal<string>('');

  /** Currently selected node path (keyboard/click selection, distinct from open file). */
  protected readonly selectedPath = signal<string | null>(null);

  /** Computed absolute path of the active file for tree highlighting. */
  protected readonly activeFileAbsolutePath = computed(() => {
    const rel = this.activeFileRelativePath();
    if (!rel) {
      return null;
    }
    const wsId = this.currentWorkspaceId();
    const ws = this.workspaces().find((w) => w.id === wsId);
    if (!ws?.path) {
      return null;
    }
    const root = normalizePathSlashes(ws.path);
    const normRel = normalizePathSlashes(rel);
    return root.endsWith('/') ? root + normRel : root + '/' + normRel;
  });

  protected readonly contextMenuVisible = signal(false);
  protected readonly contextMenuX = signal(0);
  protected readonly contextMenuY = signal(0);
  /** Absolute directory path where "New file" / "New folder" should be created. */
  protected readonly contextMenuTargetDir = signal<string | null>(null);
  /** Tree node under the pointer when the menu opened (null = empty pane / root area). */
  protected readonly contextMenuNode = signal<FlatNode | null>(null);

  /** Inline rename: absolute path of the row being edited (null = not renaming). */
  protected readonly inlineRenamePath = signal<string | null>(null);
  protected readonly inlineRenameDraft = signal<string>('');
  protected readonly inlineRenameOriginalName = signal<string>('');

  /** Inline “new file / new folder” name (replaces `window.prompt`, which is unreliable in Electron). */
  protected readonly pendingCreate = signal<{ kind: 'file' | 'folder'; parentDir: string } | null>(null);
  protected readonly pendingCreateDraft = signal<string>('');

  /** Python interpreter choices for Jedi/LSP (workspace discovery). */
  protected readonly pythonInterpreterRows = signal<PythonInterpreterListItem[]>([]);
  protected readonly pythonInterpreterSelectedId = signal('');
  protected readonly pythonInterpreterLoading = signal(false);
  protected readonly pythonInterpreterError = signal('');
  private pythonInterpreterLoadRequestId = 0;

  /** From ``GET /lsp/status`` — whether the Jedi subprocess for this session is running. */
  protected readonly lspPythonServerRunning = signal(false);
  /** From bounded workspace tree text (same scan as LLM context) — typical Python project markers / ``.py`` files. */
  protected readonly pythonWorkspaceTreeHints = signal(false);
  private interpreterChromeRequestId = 0;
  private lastInterpreterChromeWorkspaceRoot = '';

  /** Show / enable Python env controls only when the workspace looks Python-related or Jedi is already up. */
  protected readonly pythonInterpreterControlsActive = computed(() => {
    return this.lspPythonServerRunning() || this.pythonWorkspaceTreeHints();
  });

  private tree: FileNode[] = [];
  private workspaceSubscription: Subscription | null = null;
  private workspaceFilesChangedSubscription: Subscription | null = null;
  private pendingWorkspaceId: string | undefined = undefined;
  private loadRequestId = 0;
  /** After closing the context menu, ignore tree clicks briefly (avoids click-through toggling a folder). */
  private treeInteractionSuppressUntil = 0;
  /** Skip one blur-driven commit while programmatically focusing the rename field. */
  private renameSkipBlurCommit = false;
  private renameBlurTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCreateSkipBlurCancel = false;
  private lastEffectWorkspaceId: string | null | undefined = undefined;
  /** Track last revealed path to avoid redundant reveals. */
  private lastRevealedAbsolutePath: string | null = null;
  /** Flag to prevent reveal during initial tree load. */
  private initialLoadComplete = false;

  constructor(protected electron: ElectronService) {
    effect(() => {
      const wsId = this.currentWorkspaceId();
      const workspaces = this.workspaces();
      if (this.lastEffectWorkspaceId !== undefined && this.lastEffectWorkspaceId !== (wsId ?? null)) {
        this.cancelInlineRename();
        this.cancelPendingCreate();
        this.lastRevealedAbsolutePath = null;
        this.initialLoadComplete = false;
        this.selectedPath.set(null);
      }
      this.lastEffectWorkspaceId = wsId ?? null;
      void this.loadWorkspaceFromConfig(wsId, workspaces);
    });

    effect(() => {
      const absPath = this.activeFileAbsolutePath();
      const tree = this.flatTree();
      if (!absPath || !this.initialLoadComplete || tree.length === 0) {
        return;
      }
      if (absPath === this.lastRevealedAbsolutePath) {
        return;
      }
      this.lastRevealedAbsolutePath = absPath;
      void this.revealPath(absPath);
    });

    effect(() => {
      const sid = this.activeConversationId();
      const wid = this.currentWorkspaceId();
      const wss = this.workspaces();
      if (!this.electron.isElectron || !sid || !wid) {
        this.pythonInterpreterRows.set([]);
        this.pythonInterpreterSelectedId.set('');
        this.pythonInterpreterError.set('');
        return;
      }
      if (!this.pythonInterpreterControlsActive()) {
        this.pythonInterpreterRows.set([]);
        this.pythonInterpreterSelectedId.set('');
        this.pythonInterpreterError.set('');
        return;
      }
      void this.loadPythonInterpreters(sid, wid, wss);
    });

    effect(() => {
      const sid = this.activeConversationId()?.trim();
      const wid = this.currentWorkspaceId();
      const wss = this.workspaces();
      void this.activeFileRelativePath();
      if (!this.electron.isElectron || !sid || !wid) {
        untracked(() => {
          this.lspPythonServerRunning.set(false);
          this.pythonWorkspaceTreeHints.set(false);
          this.lastInterpreterChromeWorkspaceRoot = '';
        });
        return;
      }
      const ws = wss.find((w) => w.id === wid);
      const root = ws?.path?.trim();
      if (!root) {
        untracked(() => {
          this.lspPythonServerRunning.set(false);
          this.pythonWorkspaceTreeHints.set(false);
          this.lastInterpreterChromeWorkspaceRoot = '';
        });
        return;
      }
      void this.refreshWorkspaceInterpreterChrome(sid, root);
    });

    this.workspaceSubscription = this.electron.workspaceChanged$.subscribe((workspaceId) => {
      this.pendingWorkspaceId = workspaceId ?? undefined;
      void this.loadWorkspaceFromConfig();
    });

    this.workspaceFilesChangedSubscription = this.electron.workspaceFilesChanged$.subscribe((event) => {
      const currentWorkspace = this.workspaces().find((workspace) => workspace.id === this.currentWorkspaceId());
      if (!currentWorkspace || currentWorkspace.id !== event.workspaceId) {
        return;
      }

      this.lastWorkspaceChange.set(this.describeWorkspaceChange(event));
      void this.reloadPreservingExpansion(currentWorkspace.path);
      this.lastInterpreterChromeWorkspaceRoot = '';
      const sid = this.activeConversationId()?.trim();
      if (this.electron.isElectron && sid) {
        void this.refreshWorkspaceInterpreterChrome(sid, currentWorkspace.path);
      }
    });
  }

  ngOnDestroy(): void {
    this.workspaceSubscription?.unsubscribe();
    this.workspaceFilesChangedSubscription?.unsubscribe();
    if (this.renameBlurTimer !== null) {
      clearTimeout(this.renameBlurTimer);
    }
  }

  get currentWorkspaceName(): string {
    const ws = this.workspaces().find(w => w.id === this.currentWorkspaceId());
    return ws?.name ?? 'No workspace';
  }

  /** Expose path normalizer to template for active file comparison. */
  protected normalizePathSlashes = normalizePathSlashes;

  onWorkspaceSelectChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    this.workspaceChanged.emit(value || null);
  }

  async onPythonInterpreterChange(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const interpreterId = select.value;
    const wid = this.currentWorkspaceId();
    const sid = this.activeConversationId();
    if (!wid || !sid || !interpreterId) {
      return;
    }
    const prev = this.pythonInterpreterSelectedId();
    if (interpreterId === prev) {
      return;
    }
    this.pythonInterpreterLoading.set(true);
    this.pythonInterpreterError.set('');
    try {
      const res = await this.electron.applyWorkspacePythonInterpreter({
        workspaceId: wid,
        sessionId: sid,
        interpreterId,
      });
      if (!res.ok) {
        this.pythonInterpreterError.set(res.error);
        select.value = prev;
        return;
      }
      this.pythonInterpreterSelectedId.set(interpreterId);
    } catch (e) {
      this.pythonInterpreterError.set(e instanceof Error ? e.message : String(e));
      select.value = prev;
    } finally {
      this.pythonInterpreterLoading.set(false);
    }
  }

  private async loadPythonInterpreters(
    sessionId: string,
    workspaceId: string,
    workspaces: Workspace[],
  ): Promise<void> {
    const req = ++this.pythonInterpreterLoadRequestId;
    this.pythonInterpreterLoading.set(true);
    this.pythonInterpreterError.set('');
    try {
      const res = await this.electron.listPythonInterpreters(sessionId);
      if (req !== this.pythonInterpreterLoadRequestId) {
        return;
      }
      const rows = res.interpreters ?? [];
      this.pythonInterpreterRows.set(rows);
      const ws = workspaces.find((w) => w.id === workspaceId);
      const saved = (ws?.pythonInterpreterId ?? '').trim();
      let pick = '';
      if (saved && rows.some((r) => r.id === saved)) {
        pick = saved;
      } else if (
        res.ok &&
        res.activeInterpreterId &&
        rows.some((r) => r.id === res.activeInterpreterId)
      ) {
        pick = res.activeInterpreterId;
      } else if (rows.length > 0) {
        pick = rows[0].id;
      }
      this.pythonInterpreterSelectedId.set(pick);
      if (!res.ok && res.error) {
        this.pythonInterpreterError.set(res.error);
      }
    } catch (e) {
      if (req !== this.pythonInterpreterLoadRequestId) {
        return;
      }
      this.pythonInterpreterRows.set([]);
      this.pythonInterpreterSelectedId.set('');
      this.pythonInterpreterError.set(e instanceof Error ? e.message : String(e));
    } finally {
      if (req === this.pythonInterpreterLoadRequestId) {
        this.pythonInterpreterLoading.set(false);
      }
    }
  }

  private async refreshWorkspaceInterpreterChrome(sessionId: string, workspaceDiskRoot: string): Promise<void> {
    const req = ++this.interpreterChromeRequestId;
    const skipTree = this.lastInterpreterChromeWorkspaceRoot === workspaceDiskRoot;
    try {
      const dashP = this.electron.getLspDashboardStatus(sessionId);
      const treeP = skipTree
        ? Promise.resolve(null as string | null)
        : this.electron.readDirectoryRecursive(workspaceDiskRoot);
      const [dash, tree] = await Promise.all([dashP, treeP]);
      if (req !== this.interpreterChromeRequestId) {
        return;
      }
      if (tree != null) {
        this.lastInterpreterChromeWorkspaceRoot = workspaceDiskRoot;
        this.pythonWorkspaceTreeHints.set(workspaceTreeTextHintsPython(tree));
      }
      if (!dash.ok) {
        this.lspPythonServerRunning.set(false);
        return;
      }
      const st = dash.status;
      this.lspPythonServerRunning.set(st.servers?.python?.initialized === true);
    } catch {
      if (req !== this.interpreterChromeRequestId) {
        return;
      }
      this.lspPythonServerRunning.set(false);
      this.pythonWorkspaceTreeHints.set(false);
      this.lastInterpreterChromeWorkspaceRoot = '';
    }
  }

  onAddWorkspace(): void {
    this.addWorkspace.emit();
  }

  onContextMenuItemMousedown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onTreeNodeContextMenu(event: MouseEvent, node: FlatNode): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.loadError() || !this.currentWorkspaceId()) {
      return;
    }
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    if (!ws?.path) {
      return;
    }
    this.selectedPath.set(node.path);
    const targetDir = node.isDirectory ? node.path : parentDirectoryPath(node.path);
    this.openContextMenuAt(event.clientX, event.clientY, targetDir, node);
  }

  onFileTreePaneContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.tree-node')) {
      return;
    }
    event.preventDefault();
    if (this.loadError() || !this.currentWorkspaceId()) {
      return;
    }
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    if (!ws?.path) {
      return;
    }
    this.openContextMenuAt(event.clientX, event.clientY, ws.path, null);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.contextMenuVisible()) {
      return;
    }
    const inside = ev
      .composedPath()
      .some((n) => n instanceof HTMLElement && n.classList.contains('workspace-context-menu'));
    if (inside) {
      return;
    }
    this.closeContextMenu();
  }

  @HostListener('document:keydown.escape')
  onEscapeCloseContextMenu(): void {
    if (this.pendingCreate()) {
      this.cancelPendingCreate();
      return;
    }
    if (this.inlineRenamePath()) {
      this.cancelInlineRename();
      return;
    }
    if (this.contextMenuVisible()) {
      this.closeContextMenu();
    }
  }

  onContextMenuNewFile(): void {
    const dir = this.contextMenuTargetDir();
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    this.closeContextMenu();
    if (!dir || !ws?.path) {
      return;
    }
    this.beginPendingCreate('file', dir);
  }

  onContextMenuNewFolder(): void {
    const dir = this.contextMenuTargetDir();
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    this.closeContextMenu();
    if (!dir || !ws?.path) {
      return;
    }
    this.beginPendingCreate('folder', dir);
  }

  onPendingCreateDraftInput(event: Event): void {
    const v = (event.target as HTMLInputElement | null)?.value ?? '';
    this.pendingCreateDraft.set(v);
  }

  onPendingCreateKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void this.submitPendingCreate();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelPendingCreate();
    }
  }

  onPendingCreateFocusOut(event: FocusEvent): void {
    if (this.pendingCreateSkipBlurCancel) {
      return;
    }
    const next = event.relatedTarget as Node | null;
    const host = event.currentTarget as HTMLElement;
    if (next && host.contains(next)) {
      return;
    }
    setTimeout(() => {
      if (this.pendingCreateSkipBlurCancel || !this.pendingCreate()) {
        return;
      }
      const active = document.activeElement;
      if (active && host.contains(active)) {
        return;
      }
      this.cancelPendingCreate();
    }, 0);
  }

  cancelPendingCreate(): void {
    this.pendingCreate.set(null);
    this.pendingCreateDraft.set('');
  }

  async submitPendingCreate(): Promise<void> {
    const p = this.pendingCreate();
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    const draft = this.pendingCreateDraft().trim();
    if (!p || !ws?.path) {
      this.cancelPendingCreate();
      return;
    }
    if (!draft) {
      window.alert('Enter a name.');
      return;
    }
    if (!isSafeNewFileRelativeName(draft)) {
      window.alert('Invalid name.');
      return;
    }
    try {
      const res =
        p.kind === 'file'
          ? await this.electron.createWorkspaceFile(ws.path, p.parentDir, draft)
          : await this.electron.createWorkspaceFolder(ws.path, p.parentDir, draft);
      if (!res.ok) {
        window.alert(res.error ?? 'Failed to create.');
        return;
      }
      this.cancelPendingCreate();
      await this.reloadPreservingExpansion(ws.path);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  private beginPendingCreate(kind: 'file' | 'folder', parentDir: string): void {
    this.cancelInlineRename();
    this.treeInteractionSuppressUntil = Date.now() + 600;
    this.pendingCreate.set({ kind, parentDir });
    this.pendingCreateDraft.set(kind === 'file' ? 'untitled.txt' : 'New folder');
    this.schedulePendingCreateFocus();
  }

  private schedulePendingCreateFocus(): void {
    this.pendingCreateSkipBlurCancel = true;
    setTimeout(() => {
      const el = document.querySelector('app-workspace .workspace-create-inline .workspace-create-input');
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.select();
      }
      setTimeout(() => {
        this.pendingCreateSkipBlurCancel = false;
      }, 0);
    }, 0);
  }

  onContextMenuRename(): void {
    const node = this.contextMenuNode();
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    if (!node || !ws?.path) {
      this.closeContextMenu();
      return;
    }
    this.beginInlineRename(node);
  }

  private beginInlineRename(node: FlatNode): void {
    this.treeInteractionSuppressUntil = Date.now() + 600;
    this.inlineRenamePath.set(node.path);
    this.inlineRenameOriginalName.set(node.name);
    this.inlineRenameDraft.set(node.name);
    this.closeContextMenu();
    this.scheduleRenameInputFocus();
  }

  onRenameDraftInput(event: Event): void {
    const v = (event.target as HTMLInputElement | null)?.value ?? '';
    this.inlineRenameDraft.set(v);
  }

  cancelInlineRename(): void {
    if (this.renameBlurTimer !== null) {
      clearTimeout(this.renameBlurTimer);
      this.renameBlurTimer = null;
    }
    this.inlineRenamePath.set(null);
    this.inlineRenameOriginalName.set('');
    this.inlineRenameDraft.set('');
  }

  onRenameInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void this.commitInlineRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelInlineRename();
    }
  }

  onRenameInputBlur(): void {
    if (this.renameSkipBlurCommit) {
      return;
    }
    if (this.renameBlurTimer !== null) {
      clearTimeout(this.renameBlurTimer);
    }
    this.renameBlurTimer = setTimeout(() => {
      this.renameBlurTimer = null;
      void this.commitInlineRename();
    }, 0);
  }

  async commitInlineRename(): Promise<void> {
    const targetPath = this.inlineRenamePath();
    if (!targetPath) {
      return;
    }
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    const draftRaw = this.inlineRenameDraft();
    const original = this.inlineRenameOriginalName();
    const trimmed = draftRaw.trim();

    if (!ws?.path) {
      this.cancelInlineRename();
      return;
    }
    if (trimmed === '' || trimmed === original) {
      this.cancelInlineRename();
      return;
    }
    if (!isSafeRenameBasename(trimmed)) {
      window.alert('Invalid name (use a single file or folder name, no path separators).');
      this.refocusRenameInput();
      return;
    }

    const res = await this.electron.renameWorkspaceEntry(ws.path, targetPath, trimmed);
    if (!res.ok) {
      window.alert(res.error ?? 'Failed to rename.');
      this.refocusRenameInput();
      return;
    }
    this.cancelInlineRename();
    await this.reloadPreservingExpansion(ws.path);
  }

  private scheduleRenameInputFocus(): void {
    this.renameSkipBlurCommit = true;
    setTimeout(() => {
      const el = document.querySelector(
        'app-workspace .tree-node.is-renaming input.tree-node-rename-input',
      );
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.select();
      }
      setTimeout(() => {
        this.renameSkipBlurCommit = false;
      }, 0);
    }, 0);
  }

  private refocusRenameInput(): void {
    this.renameSkipBlurCommit = true;
    setTimeout(() => {
      const el = document.querySelector(
        'app-workspace .tree-node.is-renaming input.tree-node-rename-input',
      );
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.select();
      }
      setTimeout(() => {
        this.renameSkipBlurCommit = false;
      }, 0);
    }, 0);
  }

  async onContextMenuDelete(): Promise<void> {
    const node = this.contextMenuNode();
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    this.closeContextMenu();
    if (!node || !ws?.path) {
      return;
    }
    const kind = node.isDirectory ? 'folder' : 'file';
    const extra = node.isDirectory ? ' and everything inside it' : '';
    if (!window.confirm(`Delete ${kind} "${node.name}"${extra}? This cannot be undone.`)) {
      return;
    }
    const res = await this.electron.deleteWorkspaceEntry(ws.path, node.path);
    if (!res.ok) {
      window.alert(res.error ?? 'Failed to delete.');
      return;
    }
    await this.reloadPreservingExpansion(ws.path);
  }

  private openContextMenuAt(
    clientX: number,
    clientY: number,
    targetDirAbs: string,
    node: FlatNode | null,
  ): void {
    this.contextMenuTargetDir.set(targetDirAbs);
    this.contextMenuNode.set(node);
    this.contextMenuX.set(clientX);
    this.contextMenuY.set(clientY);
    this.contextMenuVisible.set(true);
  }

  private closeContextMenu(): void {
    this.contextMenuVisible.set(false);
    this.contextMenuTargetDir.set(null);
    this.contextMenuNode.set(null);
  }

  private async loadWorkspaceFromConfig(wsId = this.currentWorkspaceId(), workspaces = this.workspaces()): Promise<void> {
    const targetWorkspaceId = (this.pendingWorkspaceId !== undefined)
      ? this.pendingWorkspaceId
      : wsId;
    this.pendingWorkspaceId = undefined;
    const ws = workspaces.find(w => w.id === targetWorkspaceId);
    await this.loadRoot(ws?.path);
  }

  async loadRoot(dirPath?: string): Promise<void> {
    const requestId = ++this.loadRequestId;
    const pathToLoad = dirPath || this.workspaces().find(w => w.id === this.currentWorkspaceId())?.path;
    if (!pathToLoad) {
      this.tree = [];
      this.loadError.set('');
      this.lastWorkspaceChange.set('');
      this.rebuildFlat();
      this.initialLoadComplete = false;
      return;
    }

    try {
      const entries = await this.electron.readDirectory(pathToLoad);
      if (requestId !== this.loadRequestId) return;
      this.tree = entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDirectory: e.isDirectory,
        expanded: false,
        children: e.isDirectory ? null : [],
        depth: 0,
      }));
      this.loadError.set('');
      this.rebuildFlat();
      this.initialLoadComplete = true;
    } catch {
      if (requestId !== this.loadRequestId) return;
      this.tree = [];
      this.loadError.set('Unable to read this workspace. It may be missing or inaccessible.');
      this.rebuildFlat();
      this.initialLoadComplete = false;
    }
  }

  private async reloadPreservingExpansion(dirPath: string): Promise<void> {
    const expandedPaths = this.collectExpandedPaths(this.tree);
    await this.loadRoot(dirPath);
    if (expandedPaths.size === 0 || this.loadError()) {
      return;
    }

    await this.restoreExpandedPaths(expandedPaths);
  }

  async onTreeNodeClick(node: FlatNode): Promise<void> {
    if (Date.now() < this.treeInteractionSuppressUntil) {
      return;
    }
    if (this.inlineRenamePath() === node.path) {
      return;
    }
    this.selectedPath.set(node.path);
    if (!node.isDirectory) {
      return;
    }
    await this.toggleFolder(node);
  }

  onTreeNodeDoubleClick(node: FlatNode): void {
    if (Date.now() < this.treeInteractionSuppressUntil) {
      return;
    }
    if (this.inlineRenamePath() === node.path) {
      return;
    }
    this.selectedPath.set(node.path);
    if (node.isDirectory) {
      return;
    }
    this.workspaceFileOpen.emit({ absolutePath: node.path });
  }

  onTreeKeydown(event: KeyboardEvent): void {
    const flat = this.flatTree();
    if (flat.length === 0) {
      return;
    }

    const currentSelected = this.selectedPath();
    let currentIndex = currentSelected ? flat.findIndex((n) => n.path === currentSelected) : -1;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (currentIndex < flat.length - 1) {
          this.selectedPath.set(flat[currentIndex + 1].path);
          this.scrollToSelectedNode();
        } else if (currentIndex === -1 && flat.length > 0) {
          this.selectedPath.set(flat[0].path);
          this.scrollToSelectedNode();
        }
        break;

      case 'ArrowUp':
        event.preventDefault();
        if (currentIndex > 0) {
          this.selectedPath.set(flat[currentIndex - 1].path);
          this.scrollToSelectedNode();
        } else if (currentIndex === -1 && flat.length > 0) {
          this.selectedPath.set(flat[flat.length - 1].path);
          this.scrollToSelectedNode();
        }
        break;

      case 'ArrowRight':
        event.preventDefault();
        if (currentIndex >= 0) {
          const node = flat[currentIndex];
          if (node.isDirectory) {
            if (!node.expanded) {
              void this.toggleFolder(node);
            } else if (currentIndex < flat.length - 1) {
              this.selectedPath.set(flat[currentIndex + 1].path);
              this.scrollToSelectedNode();
            }
          }
        }
        break;

      case 'ArrowLeft':
        event.preventDefault();
        if (currentIndex >= 0) {
          const node = flat[currentIndex];
          if (node.isDirectory && node.expanded) {
            void this.toggleFolder(node);
          } else {
            const parentPath = this.findParentPath(node.path);
            if (parentPath) {
              this.selectedPath.set(parentPath);
              this.scrollToSelectedNode();
            }
          }
        }
        break;

      case 'Enter':
        event.preventDefault();
        if (currentIndex >= 0) {
          const node = flat[currentIndex];
          if (node.isDirectory) {
            void this.toggleFolder(node);
          } else {
            this.workspaceFileOpen.emit({ absolutePath: node.path });
          }
        }
        break;

      case 'Home':
        event.preventDefault();
        if (flat.length > 0) {
          this.selectedPath.set(flat[0].path);
          this.scrollToSelectedNode();
        }
        break;

      case 'End':
        event.preventDefault();
        if (flat.length > 0) {
          this.selectedPath.set(flat[flat.length - 1].path);
          this.scrollToSelectedNode();
        }
        break;
    }
  }

  private findParentPath(childPath: string): string | null {
    const flat = this.flatTree();
    const childIndex = flat.findIndex((n) => n.path === childPath);
    if (childIndex <= 0) {
      return null;
    }

    const childDepth = flat[childIndex].depth;
    for (let i = childIndex - 1; i >= 0; i--) {
      if (flat[i].depth < childDepth && flat[i].isDirectory) {
        return flat[i].path;
      }
    }
    return null;
  }

  private scrollToSelectedNode(): void {
    const selected = this.selectedPath();
    if (!selected) {
      return;
    }
    requestAnimationFrame(() => {
      const el = document.querySelector(`app-workspace .tree-node[data-path="${CSS.escape(selected)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  async toggleFolder(node: FlatNode): Promise<void> {
    const treeNode = this.findNode(this.tree, node.path);
    if (!treeNode || !treeNode.isDirectory) return;

    if (treeNode.expanded) {
      treeNode.expanded = false;
    } else {
      if (treeNode.children === null) {
        try {
          const entries = await this.electron.readDirectory(treeNode.path);
          treeNode.children = entries.map((e) => ({
            name: e.name,
            path: e.path,
            isDirectory: e.isDirectory,
            expanded: false,
            children: e.isDirectory ? null : [],
            depth: treeNode.depth + 1,
          }));
        } catch {
          treeNode.children = [];
        }
      }
      treeNode.expanded = true;
    }
    this.rebuildFlat();
  }

  private findNode(nodes: FileNode[], targetPath: string): FileNode | null {
    for (const n of nodes) {
      if (n.path === targetPath) return n;
      if (n.children) {
        const found = this.findNode(n.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  }

  private rebuildFlat(): void {
    const result: FlatNode[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        result.push({
          name: n.name,
          path: n.path,
          isDirectory: n.isDirectory,
          expanded: n.expanded,
          depth: n.depth,
          hasChildren: n.isDirectory && (n.children === null || n.children.length > 0),
        });
        if (n.expanded && n.children) {
          walk(n.children);
        }
      }
    };
    walk(this.tree);
    this.flatTree.set(result);
  }

  private collectExpandedPaths(nodes: FileNode[]): Set<string> {
    const expandedPaths = new Set<string>();
    const walk = (items: FileNode[]) => {
      for (const item of items) {
        if (item.isDirectory && item.expanded) {
          expandedPaths.add(item.path);
        }
        if (item.children && item.children.length > 0) {
          walk(item.children);
        }
      }
    };
    walk(nodes);
    return expandedPaths;
  }

  private async restoreExpandedPaths(expandedPaths: Set<string>): Promise<void> {
    const sortedPaths = Array.from(expandedPaths).sort((a, b) => a.length - b.length);
    for (const targetPath of sortedPaths) {
      const node = this.findNode(this.tree, targetPath);
      if (!node || !node.isDirectory) {
        continue;
      }

      if (node.children === null) {
        try {
          const entries = await this.electron.readDirectory(node.path);
          node.children = entries.map((entry) => ({
            name: entry.name,
            path: entry.path,
            isDirectory: entry.isDirectory,
            expanded: false,
            children: entry.isDirectory ? null : [],
            depth: node.depth + 1,
          }));
        } catch {
          node.children = [];
        }
      }

      node.expanded = true;
    }

    this.rebuildFlat();
  }

  /**
   * Expand all ancestor folders to reveal a file at the given absolute path,
   * then scroll the file into view.
   */
  async revealPath(absolutePath: string): Promise<void> {
    const wsId = this.currentWorkspaceId();
    const ws = this.workspaces().find((w) => w.id === wsId);
    if (!ws?.path) {
      return;
    }

    const normalizedTarget = normalizePathSlashes(absolutePath);
    const normalizedRoot = normalizePathSlashes(ws.path);

    if (!normalizedTarget.startsWith(normalizedRoot)) {
      return;
    }

    const relativePart = normalizedTarget.slice(normalizedRoot.length).replace(/^\//, '');
    if (!relativePart) {
      return;
    }

    const segments = relativePart.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      return;
    }

    let currentPath = normalizedRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = currentPath + '/' + segments[i];
      const node = this.findNodeByNormalizedPath(this.tree, currentPath);
      if (!node || !node.isDirectory) {
        break;
      }

      if (!node.expanded) {
        if (node.children === null) {
          try {
            const entries = await this.electron.readDirectory(node.path);
            node.children = entries.map((entry) => ({
              name: entry.name,
              path: entry.path,
              isDirectory: entry.isDirectory,
              expanded: false,
              children: entry.isDirectory ? null : [],
              depth: node.depth + 1,
            }));
          } catch {
            node.children = [];
          }
        }
        node.expanded = true;
      }
    }

    this.rebuildFlat();
    this.scrollToPath(absolutePath);
  }

  private findNodeByNormalizedPath(nodes: FileNode[], normalizedPath: string): FileNode | null {
    for (const n of nodes) {
      if (normalizePathSlashes(n.path) === normalizedPath) {
        return n;
      }
      if (n.children) {
        const found = this.findNodeByNormalizedPath(n.children, normalizedPath);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  private scrollToPath(absolutePath: string): void {
    requestAnimationFrame(() => {
      const el = document.querySelector(`app-workspace .tree-node[data-path="${CSS.escape(absolutePath)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  private describeWorkspaceChange(event: { paths: string[]; kinds: WorkspaceChangeKind[] }): string {
    const kind = event.kinds[0] ?? 'unknown';
    const pathLabel = event.paths[0] ?? 'workspace';
    const moreCount = Math.max(0, event.paths.length - 1);
    const kindLabel = kind === 'unknown' ? 'changed' : kind;
    if (moreCount === 0) {
      return `${pathLabel} ${kindLabel}`;
    }
    return `${pathLabel} ${kindLabel} (+${moreCount} more)`;
  }
}

function parentDirectoryPath(filePath: string): string {
  const trimmed = filePath.replace(/[/\\]+$/, '');
  const m = trimmed.match(/^(.+)[\\/][^\\/]+$/);
  return m ? m[1] : trimmed;
}

function isSafeNewFileRelativeName(name: string): boolean {
  const parts = normalizePathSlashes(name)
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return false;
  }
  for (const p of parts) {
    if (p === '..' || p === '.') {
      return false;
    }
  }
  return true;
}

/** Single path segment only (rename in same folder). */
function isSafeRenameBasename(name: string): boolean {
  const parts = normalizePathSlashes(name)
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length !== 1) {
    return false;
  }
  const p = parts[0];
  return p !== '..' && p !== '.';
}

/** Detect typical Python project files in bounded workspace tree text (``buildWorkspaceTree`` output). */
function workspaceTreeTextHintsPython(tree: string): boolean {
  const raw = tree.trim();
  if (!raw) {
    return false;
  }
  const tl = raw.toLowerCase();
  const markers = [
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'requirements.in',
    'pipfile',
    'poetry.lock',
    'pdm.lock',
    'uv.lock',
    'manage.py',
    'tox.ini',
    'environment.yml',
    'environment.yaml',
    'conda.yml',
    'conda.yaml',
    '.python-version',
    'pyrightconfig.json',
    'ruff.toml',
    '.ruff.toml',
    'pytest.ini',
    'mypy.ini',
    '.flake8',
    'pixi.toml',
  ];
  for (const m of markers) {
    if (tl.includes(m)) {
      return true;
    }
  }
  return /[^\s|'"`]+\.(?:py|pyi)(?:\s|$|\n|\[)/.test(raw);
}
