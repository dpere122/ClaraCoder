import {
  Component,
  computed,
  effect,
  HostListener,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import type { AppConfig, PythonInterpreterListItem, Workspace, WorkspaceFilesChangedMessage } from '@shared/index';
import { lspServerKindForWorkspaceRelativePath, RUNTIME_VENV_INTERPRETER_ID } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { ManagedLlamaControlsComponent } from '../../status/managed-llama-controls/managed-llama-controls';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { workspaceEntryDeletePrompt } from '../../../shared/themed-confirm-dialog/format-delete-prompt';
import { WorkspaceFileChangeStatusService } from '../../../core/workspace-file-change-status.service';
import { Subscription } from 'rxjs';
import type { EditorOutlineSymbol } from '../editor-outline/editor-outline';
import { WorkspaceOutlineDockComponent } from '../workspace-outline-dock/workspace-outline-dock';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import {
  absolutePathsFromWorkspaceChangeEvent,
  collectExpandedPaths,
  fileNodesFromDirectoryEntries,
  workspaceFileBasename,
  findFileNode,
  findFileNodeByNormalizedPath,
  findParentPathInFlatTree,
  findPendingCreateInsertIndex,
  isPendingCreateTreeNode,
  joinTreeAbsolutePath,
  mergeDirectoryListingIntoChildren,
  normalizeTreeAbsolutePath,
  parentWorkspaceRelativePath,
  PENDING_CREATE_TREE_PATH,
  rebuildFlatTree,
  removeFileNodeAtPath,
  renameFileNodeAtPath,
  scrollWorkspaceTreeNodeToPath,
  scrollWorkspaceTreeNodeToSelected,
  shouldReloadWorkspaceTree,
  workspaceFileChangeDescriptorsFromEvent,
  type FileNode,
  type FlatNode,
  type WorkspaceTreeLoadKey,
} from './workspace-tree';
import {
  isSafeNewFileRelativeName,
  isSafeRenameBasename,
  parentDirectoryPath,
} from './workspace-path-utils';
import { workspaceTreeTextHintsPython } from './workspace-python-hints';
import {
  populateWorkspacePathDragData,
  WORKSPACE_TREE_INTERNAL_MOVE_MIME,
} from '../../chat/chat-context-bar/chat-context-file';

@Component({
  selector: 'app-workspace',
  imports: [LucideAngularModule, WorkspaceOutlineDockComponent, ManagedLlamaControlsComponent],
  templateUrl: './workspace.html',
  styleUrl: './workspace.css',
  encapsulation: ViewEncapsulation.None,
})
export class WorkspaceComponent implements OnDestroy {
  private readonly workspaceFileChangeStatus = inject(WorkspaceFileChangeStatusService);
  private readonly themedConfirm = inject(ThemedConfirmDialogService);

  readonly workspaces = input<Workspace[]>([]);
  readonly currentWorkspaceId = input<string | null>(null);
  /** Active chat session id — Python LSP / interpreter APIs key off this. */
  readonly activeConversationId = input<string | null>(null);
  /** Active editor tab path (workspace-relative); drives which integrated LSP is warmed and shown. */
  readonly activeFileRelativePath = input<string | null>(null);
  /** Document outline symbols from the active Monaco tab. */
  readonly outlineSymbols = input<readonly EditorOutlineSymbol[]>([]);
  /** Live app config from the shell; drives the managed llama-server Start/Stop controls in the footer. */
  readonly appConfig = input<AppConfig | null>(null);
  /** Relative path for the active outline (from Monaco). */
  readonly outlineRelativePath = input<string | null>(null);

  readonly workspaceChanged = output<string | null>();
  readonly addWorkspace = output<void>();
  /** User double-clicked a file in the tree (absolute path on disk). */
  readonly workspaceFileOpen = output<{ absolutePath: string }>();
  /** User chose "Add to chat" or dragged a file/folder out of the tree (absolute path on disk). */
  readonly addToChatContext = output<{ absolutePath: string; isDirectory: boolean }>();
  /** User clicked a symbol in the outline panel — reveal in the editor. */
  readonly outlineSymbolReveal = output<{ relativePath: string; line: number; column: number }>();

  protected readonly flatTree = signal<FlatNode[]>([]);
  /** Flat tree with an inline pending-create row when the user is naming a new file/folder. */
  protected readonly displayFlatTree = computed(() => {
    const flat = this.flatTree();
    const pc = this.pendingCreate();
    if (!pc) {
      return flat;
    }
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    if (!ws?.path) {
      return flat;
    }
    const { index, depth } = findPendingCreateInsertIndex(flat, pc.parentDir, ws.path);
    const placeholder: FlatNode = {
      name: '',
      path: PENDING_CREATE_TREE_PATH,
      isDirectory: pc.kind === 'folder',
      expanded: false,
      depth,
      hasChildren: false,
    };
    return [...flat.slice(0, index), placeholder, ...flat.slice(index)];
  });
  protected readonly loadError = signal('');
  /** Cog / system-prompt open failures — keep off `loadError` so the file tree stays visible. */
  protected readonly settingsError = signal('');
  protected readonly settingsOpening = signal(false);
  /** Selected workspace has a non-empty folder path (cog stays disabled until then). */
  protected readonly currentWorkspaceHasPath = computed(() => {
    const id = this.currentWorkspaceId();
    if (!id) {
      return false;
    }
    const ws = this.workspaces().find((w) => w.id === id);
    return !!(ws?.path?.trim());
  });

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

  /** Python interpreter choices for Python LSP (workspace discovery). */
  protected readonly pythonInterpreterRows = signal<PythonInterpreterListItem[]>([]);
  protected readonly pythonInterpreterSelectedId = signal('');
  protected readonly pythonInterpreterLoading = signal(false);
  protected readonly pythonInterpreterError = signal('');
  private pythonInterpreterLoadRequestId = 0;

  /** From ``GET /lsp/status`` — whether the Python LSP subprocess for this session is running. */
  protected readonly lspPythonServerRunning = signal(false);
  /** From bounded workspace tree text (same scan as LLM context) — typical Python project markers / ``.py`` files. */
  protected readonly pythonWorkspaceTreeHints = signal(false);
  private interpreterChromeRequestId = 0;
  private lastInterpreterChromeWorkspaceRoot = '';

  /** Show / enable Python env controls only when the workspace looks Python-related or the Python LSP is already up. */
  protected readonly pythonInterpreterControlsActive = computed(() => {
    return this.lspPythonServerRunning() || this.pythonWorkspaceTreeHints();
  });

  /** Show outline dock when the active tab is an LSP-supported file. */
  protected readonly outlinePanelVisible = computed(() => {
    const rel = this.outlineRelativePath()?.trim() || this.activeFileRelativePath()?.trim();
    if (!rel) {
      return false;
    }
    return !!lspServerKindForWorkspaceRelativePath(rel.replace(/\\/g, '/'));
  });

  /** Load interpreter list only when the workspace hints Python or a ``.py`` tab is active. */
  protected readonly shouldLoadPythonInterpreters = computed(() => {
    const path = this.activeFileRelativePath()?.trim().replace(/\\/g, '/');
    const activePy = path ? lspServerKindForWorkspaceRelativePath(path) === 'python' : false;
    return this.pythonWorkspaceTreeHints() || activePy;
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
  private renameFocusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Skip one blur-driven commit while programmatically focusing the create field. */
  private pendingCreateSkipBlurCommit = false;
  private pendingCreateBlurTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCreateFocusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEffectWorkspaceId: string | null | undefined = undefined;
  /** Track last revealed path to avoid redundant reveals. */
  private lastRevealedAbsolutePath: string | null = null;
  /** Flag to prevent reveal during initial tree load. */
  private initialLoadComplete = false;
  /** Workspace identity for which `tree` was last loaded from disk. */
  private lastLoadedWorkspaceKey: WorkspaceTreeLoadKey | null = null;

  /** Drop target folder (absolute path) while dragging over the tree. */
  protected readonly treeDropTargetDir = signal<string | null>(null);
  protected readonly fileTreeDropActive = signal(false);

  /** Absolute paths with an in-flight disk operation (spinner until the tree reloads). */
  protected readonly diskOpPendingPaths = signal<ReadonlySet<string>>(new Set());

  private diskOpFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DISK_OP_FALLBACK_RELOAD_MS = 2_000;

  constructor(protected electron: ElectronService) {
    effect(() => {
      const wsId = this.currentWorkspaceId();
      const workspaces = this.workspaces();
      if (this.lastEffectWorkspaceId !== undefined && this.lastEffectWorkspaceId !== (wsId ?? null)) {
        this.cancelInlineRename();
        this.cancelPendingCreate();
        this.clearAllDiskOpPending();
        this.lastRevealedAbsolutePath = null;
        this.initialLoadComplete = false;
        this.lastLoadedWorkspaceKey = null;
        this.selectedPath.set(null);
        this.settingsError.set('');
        this.settingsOpening.set(false);
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
      if (!this.shouldLoadPythonInterpreters()) {
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

      const path = event.paths[0] ?? '';
      if (path) {
        this.workspaceFileChangeStatus.showFileName(workspaceFileBasename(path));
      }
      const clearedPaths = absolutePathsFromWorkspaceChangeEvent(currentWorkspace.path, event);
      void this.applyWorkspaceFileChanges(currentWorkspace.path, event).finally(() => {
        this.clearDiskOpPending(...clearedPaths);
      });
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
    this.clearAllDiskOpPending();
    if (this.renameBlurTimer !== null) {
      clearTimeout(this.renameBlurTimer);
    }
    if (this.renameFocusTimer !== null) {
      clearTimeout(this.renameFocusTimer);
    }
    if (this.pendingCreateBlurTimer !== null) {
      clearTimeout(this.pendingCreateBlurTimer);
    }
    if (this.pendingCreateFocusTimer !== null) {
      clearTimeout(this.pendingCreateFocusTimer);
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

  protected onOutlineSymbolReveal(sym: EditorOutlineSymbol): void {
    const rel = this.outlineRelativePath()?.trim() || this.activeFileRelativePath()?.trim();
    if (!rel) {
      return;
    }
    const r = sym.selectionRange ?? sym.range;
    this.outlineSymbolReveal.emit({
      relativePath: normalizePathSlashes(rel),
      line: r.startLineNumber,
      column: r.startColumn,
    });
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
      } else {
        const runtime = rows.find((r) => r.id === RUNTIME_VENV_INTERPRETER_ID);
        pick = runtime?.id ?? rows[0]?.id ?? '';
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

  protected async onOpenWorkspaceSettings(): Promise<void> {
    const wid = this.currentWorkspaceId();
    if (!wid || !this.electron.isElectron) {
      return;
    }
    this.settingsError.set('');
    const ws = this.workspaces().find((w) => w.id === wid);
    if (!ws?.path?.trim()) {
      this.settingsError.set('Workspace has no folder path.');
      return;
    }
    this.settingsOpening.set(true);
    try {
      const res = await this.electron.ensureWorkspaceSystemPrompt(wid, this.activeConversationId());
      if (!res.ok) {
        this.settingsError.set(res.error || 'Failed to open workspace system prompt.');
        return;
      }
      this.settingsError.set('');
      this.workspaceFileOpen.emit({ absolutePath: res.absolutePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.settingsError.set(msg || 'Failed to open workspace system prompt.');
    } finally {
      this.settingsOpening.set(false);
    }
  }

  onContextMenuItemMousedown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  onTreeNodeContextMenu(event: MouseEvent, node: FlatNode): void {
    event.preventDefault();
    event.stopPropagation();
    if (isPendingCreateTreeNode(node) || this.loadError() || !this.currentWorkspaceId()) {
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
    void this.beginPendingCreate('file', dir);
  }

  onContextMenuNewFolder(): void {
    const dir = this.contextMenuTargetDir();
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    this.closeContextMenu();
    if (!dir || !ws?.path) {
      return;
    }
    void this.beginPendingCreate('folder', dir);
  }

  onPendingCreateDraftInput(event: Event): void {
    const v = (event.target as HTMLInputElement | null)?.value ?? '';
    this.pendingCreateDraft.set(v);
  }

  onPendingCreateKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.commitPendingCreate();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelPendingCreate();
    }
  }

  onPendingCreateInputBlur(): void {
    if (this.pendingCreateSkipBlurCommit) {
      return;
    }
    this.clearPendingCreateFocusTimer();
    if (this.pendingCreateBlurTimer !== null) {
      clearTimeout(this.pendingCreateBlurTimer);
    }
    this.pendingCreateBlurTimer = setTimeout(() => {
      this.pendingCreateBlurTimer = null;
      void this.commitPendingCreate();
    }, 0);
  }

  cancelPendingCreate(): void {
    if (this.pendingCreateBlurTimer !== null) {
      clearTimeout(this.pendingCreateBlurTimer);
      this.pendingCreateBlurTimer = null;
    }
    this.clearPendingCreateFocusTimer();
    this.pendingCreate.set(null);
    this.pendingCreateDraft.set('');
    this.releaseFileTreeKeyboardFocus();
  }

  async commitPendingCreate(): Promise<void> {
    const draft = this.pendingCreateDraft().trim();
    if (!draft) {
      this.cancelPendingCreate();
      return;
    }
    await this.submitPendingCreate();
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
      this.cancelPendingCreate();
      return;
    }
    if (!isSafeNewFileRelativeName(draft)) {
      window.alert('Invalid name.');
      return;
    }
    const newAbsPath = joinTreeAbsolutePath(p.parentDir, draft);
    this.markDiskOpPending(newAbsPath, p.parentDir);
    try {
      const res =
        p.kind === 'file'
          ? await this.electron.createWorkspaceFile(ws.path, p.parentDir, draft)
          : await this.electron.createWorkspaceFolder(ws.path, p.parentDir, draft);
      if (!res.ok) {
        this.clearDiskOpPending(newAbsPath, p.parentDir);
        window.alert(res.error ?? 'Failed to create.');
        return;
      }
      this.cancelPendingCreate();
    } catch (e) {
      this.clearDiskOpPending(newAbsPath, p.parentDir);
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  private async beginPendingCreate(kind: 'file' | 'folder', parentDir: string): Promise<void> {
    this.cancelInlineRename();
    this.treeInteractionSuppressUntil = Date.now() + 600;
    await this.ensureDirectoryExpanded(parentDir);
    this.pendingCreate.set({ kind, parentDir });
    this.pendingCreateDraft.set(kind === 'file' ? 'untitled.txt' : 'New folder');
    this.schedulePendingCreateFocus();
  }

  private async ensureDirectoryExpanded(absoluteDir: string): Promise<void> {
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    if (!ws?.path) {
      return;
    }
    const rootNorm = normalizePathSlashes(ws.path).replace(/\/$/, '');
    const dirNorm = normalizePathSlashes(absoluteDir).replace(/\/$/, '');
    if (dirNorm === rootNorm) {
      return;
    }
    const node = findFileNode(this.tree, absoluteDir);
    if (!node?.isDirectory || node.expanded) {
      return;
    }
    if (node.children === null) {
      try {
        const entries = await this.electron.readDirectory(node.path);
        node.children = fileNodesFromDirectoryEntries(entries, node.depth + 1);
      } catch {
        node.children = [];
      }
    }
    node.expanded = true;
    this.rebuildFlat();
  }

  private schedulePendingCreateFocus(): void {
    this.clearPendingCreateFocusTimer();
    this.pendingCreateSkipBlurCommit = true;
    this.pendingCreateFocusTimer = setTimeout(() => {
      this.pendingCreateFocusTimer = null;
      if (!this.pendingCreate()) {
        this.pendingCreateSkipBlurCommit = false;
        return;
      }
      const el = document.querySelector(
        'app-workspace .tree-node.is-pending-create input.tree-node-rename-input',
      );
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.select();
      }
      document
        .querySelector('app-workspace .tree-node.is-pending-create')
        ?.scrollIntoView({ block: 'nearest' });
      setTimeout(() => {
        this.pendingCreateSkipBlurCommit = false;
      }, 0);
    }, 0);
  }

  protected isPendingCreateTreeNode(node: FlatNode): boolean {
    return isPendingCreateTreeNode(node);
  }

  protected isTreeNodeInlineEditing(node: FlatNode): boolean {
    return isPendingCreateTreeNode(node) || this.inlineRenamePath() === node.path;
  }

  protected isTreeNodeDiskOpPending(node: FlatNode): boolean {
    if (isPendingCreateTreeNode(node)) {
      return false;
    }
    return this.diskOpPendingPaths().has(normalizeTreeAbsolutePath(node.path));
  }

  private markDiskOpPending(...paths: string[]): void {
    const normalized = paths.map((p) => normalizeTreeAbsolutePath(p)).filter((p) => p.length > 0);
    if (normalized.length === 0) {
      return;
    }
    const next = new Set(this.diskOpPendingPaths());
    for (const p of normalized) {
      next.add(p);
      this.scheduleDiskOpFallbackReload(p);
    }
    this.diskOpPendingPaths.set(next);
  }

  private clearDiskOpPending(...paths: string[]): void {
    const normalized = paths.map((p) => normalizeTreeAbsolutePath(p)).filter((p) => p.length > 0);
    if (normalized.length === 0) {
      return;
    }
    const next = new Set(this.diskOpPendingPaths());
    for (const p of normalized) {
      next.delete(p);
      this.clearDiskOpFallbackTimer(p);
    }
    this.diskOpPendingPaths.set(next);
  }

  private clearAllDiskOpPending(): void {
    for (const p of this.diskOpPendingPaths()) {
      this.clearDiskOpFallbackTimer(p);
    }
    this.diskOpPendingPaths.set(new Set());
  }

  private scheduleDiskOpFallbackReload(pendingPath: string): void {
    this.clearDiskOpFallbackTimer(pendingPath);
    const timer = setTimeout(() => {
      this.diskOpFallbackTimers.delete(pendingPath);
      if (!this.diskOpPendingPaths().has(pendingPath)) {
        return;
      }
      const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
      if (!ws?.path) {
        this.clearDiskOpPending(pendingPath);
        return;
      }
      void this.reloadPreservingExpansion(ws.path).finally(() => {
        this.clearDiskOpPending(pendingPath);
      });
    }, WorkspaceComponent.DISK_OP_FALLBACK_RELOAD_MS);
    this.diskOpFallbackTimers.set(pendingPath, timer);
  }

  private clearDiskOpFallbackTimer(pendingPath: string): void {
    const timer = this.diskOpFallbackTimers.get(pendingPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.diskOpFallbackTimers.delete(pendingPath);
    }
  }

  onContextMenuAddToChat(): void {
    const node = this.contextMenuNode();
    this.closeContextMenu();
    if (!node) {
      return;
    }
    this.addToChatContext.emit({ absolutePath: node.path, isDirectory: node.isDirectory });
  }

  async onContextMenuOpenInFileExplorer(): Promise<void> {
    const node = this.contextMenuNode();
    this.closeContextMenu();
    if (!node) {
      return;
    }
    const res = await this.electron.showWorkspacePathInFileManager(node.path);
    if (!res.ok) {
      window.alert(res.error ?? 'Failed to open in file explorer.');
    }
  }

  onTreeNodeDragStart(event: DragEvent, node: FlatNode): void {
    if (this.isTreeNodeInlineEditing(node) || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    populateWorkspacePathDragData(event.dataTransfer, node.path, {
      isDirectory: node.isDirectory,
      internalMove: true,
    });
  }

  onTreeNodeDragEnd(): void {
    this.clearTreeDropTarget();
  }

  onFileTreeDragOver(event: DragEvent): void {
    if (!this.canAcceptTreeDrop(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = this.isInternalTreeDrag(event) ? 'move' : 'copy';
    }
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    if (ws?.path) {
      this.fileTreeDropActive.set(true);
      this.treeDropTargetDir.set(ws.path);
    }
  }

  onFileTreeDragLeave(event: DragEvent): void {
    const related = event.relatedTarget;
    const tree = event.currentTarget;
    if (related instanceof Node && tree instanceof Node && tree.contains(related)) {
      return;
    }
    this.clearTreeDropTarget();
  }

  onFileTreeDrop(event: DragEvent): void {
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    this.clearTreeDropTarget();
    if (!ws?.path || !this.canAcceptTreeDrop(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.performTreeDrop(event, ws.path, ws.path);
  }

  onTreeNodeDragOver(event: DragEvent, node: FlatNode): void {
    if (!this.canAcceptTreeDrop(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = this.isInternalTreeDrag(event) ? 'move' : 'copy';
    }
    this.fileTreeDropActive.set(false);
    this.treeDropTargetDir.set(this.dropTargetDirForNode(node));
  }

  onTreeNodeDragLeave(event: DragEvent, node: FlatNode): void {
    const related = event.relatedTarget;
    const row = event.currentTarget;
    if (related instanceof Node && row instanceof Node && row.contains(related)) {
      return;
    }
    if (normalizePathSlashes(this.treeDropTargetDir() ?? '') === normalizePathSlashes(this.dropTargetDirForNode(node))) {
      this.clearTreeDropTarget();
    }
  }

  onTreeNodeDrop(event: DragEvent, node: FlatNode): void {
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    const destDir = this.dropTargetDirForNode(node);
    this.clearTreeDropTarget();
    if (!ws?.path || !this.canAcceptTreeDrop(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.performTreeDrop(event, ws.path, destDir);
  }

  protected isTreeDropTarget(node: FlatNode): boolean {
    if (isPendingCreateTreeNode(node)) {
      return false;
    }
    const targetDir = this.treeDropTargetDir();
    if (!targetDir) {
      return false;
    }
    return normalizePathSlashes(this.dropTargetDirForNode(node)) === normalizePathSlashes(targetDir);
  }

  private dropTargetDirForNode(node: FlatNode): string {
    return node.isDirectory ? node.path : parentDirectoryPath(node.path);
  }

  private clearTreeDropTarget(): void {
    this.treeDropTargetDir.set(null);
    this.fileTreeDropActive.set(false);
  }

  private isInternalTreeDrag(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes(WORKSPACE_TREE_INTERNAL_MOVE_MIME) ?? false;
  }

  private canAcceptTreeDrop(event: DragEvent): boolean {
    const dt = event.dataTransfer;
    if (!dt || this.pendingCreate() || this.inlineRenamePath()) {
      return false;
    }
    if (this.isInternalTreeDrag(event)) {
      return true;
    }
    return dt.types.includes('Files') && dt.files.length > 0;
  }

  private internalDragSourcePath(event: DragEvent): string | null {
    const raw = event.dataTransfer?.getData(WORKSPACE_TREE_INTERNAL_MOVE_MIME)?.trim();
    return raw || null;
  }

  private externalDragSourcePaths(event: DragEvent): string[] {
    const dt = event.dataTransfer;
    if (!dt) {
      return [];
    }
    const paths: string[] = [];
    for (let i = 0; i < dt.files.length; i++) {
      const file = dt.files[i] as File & { path?: string };
      const p = file.path?.trim();
      if (p) {
        paths.push(p);
      }
    }
    return paths;
  }

  private async performTreeDrop(event: DragEvent, workspaceRoot: string, destParentDir: string): Promise<void> {
    const internalSource = this.internalDragSourcePath(event);
    if (internalSource) {
      if (normalizePathSlashes(internalSource) === normalizePathSlashes(destParentDir)) {
        return;
      }
      if (normalizePathSlashes(parentDirectoryPath(internalSource)) === normalizePathSlashes(destParentDir)) {
        return;
      }
      this.markDiskOpPending(internalSource, destParentDir);
      const res = await this.electron.moveWorkspaceEntry(workspaceRoot, internalSource, destParentDir);
      if (!res.ok) {
        this.clearDiskOpPending(internalSource, destParentDir);
        window.alert(res.error ?? 'Failed to move item.');
        return;
      }
      return;
    }

    const externalSources = this.externalDragSourcePaths(event);
    if (externalSources.length === 0) {
      return;
    }
    this.markDiskOpPending(destParentDir);
    const res = await this.electron.importPathsIntoWorkspace(workspaceRoot, destParentDir, externalSources);
    if (!res.ok) {
      this.clearDiskOpPending(destParentDir);
      window.alert(res.error ?? 'Failed to import item(s).');
    }
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
    this.clearRenameFocusTimer();
    this.inlineRenamePath.set(null);
    this.inlineRenameOriginalName.set('');
    this.inlineRenameDraft.set('');
    this.releaseFileTreeKeyboardFocus();
  }

  onRenameInputKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
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
    this.clearRenameFocusTimer();
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

    const newAbsPath = joinTreeAbsolutePath(parentDirectoryPath(targetPath), trimmed);
    this.markDiskOpPending(targetPath, newAbsPath);
    const res = await this.electron.renameWorkspaceEntry(ws.path, targetPath, trimmed);
    if (!res.ok) {
      this.clearDiskOpPending(targetPath, newAbsPath);
      window.alert(res.error ?? 'Failed to rename.');
      this.refocusRenameInput();
      return;
    }
    this.cancelInlineRename();
  }

  private scheduleRenameInputFocus(): void {
    this.clearRenameFocusTimer();
    this.renameSkipBlurCommit = true;
    this.renameFocusTimer = setTimeout(() => {
      this.renameFocusTimer = null;
      if (!this.inlineRenamePath()) {
        this.renameSkipBlurCommit = false;
        return;
      }
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
    this.scheduleRenameInputFocus();
  }

  /** Drop focus from the tree pane so arrow/space keys reach the user's intended target. */
  private releaseFileTreeKeyboardFocus(): void {
    const blurTree = (): void => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.classList.contains('file-tree')) {
        active.blur();
      }
    };
    blurTree();
    setTimeout(blurTree, 0);
  }

  private clearRenameFocusTimer(): void {
    if (this.renameFocusTimer !== null) {
      clearTimeout(this.renameFocusTimer);
      this.renameFocusTimer = null;
    }
  }

  private clearPendingCreateFocusTimer(): void {
    if (this.pendingCreateFocusTimer !== null) {
      clearTimeout(this.pendingCreateFocusTimer);
      this.pendingCreateFocusTimer = null;
    }
  }

  async onContextMenuDelete(): Promise<void> {
    const node = this.contextMenuNode();
    const ws = this.workspaces().find((w) => w.id === this.currentWorkspaceId());
    this.closeContextMenu();
    if (!node || !ws?.path) {
      return;
    }
    const confirmed =
      (await this.themedConfirm.open(
        workspaceEntryDeletePrompt({ name: node.name, isDirectory: node.isDirectory }),
      )) === 'confirm';
    if (!confirmed) {
      return;
    }
    this.markDiskOpPending(node.path);
    const res = await this.electron.deleteWorkspaceEntry(ws.path, node.path);
    if (!res.ok) {
      this.clearDiskOpPending(node.path);
      window.alert(res.error ?? 'Failed to delete.');
      return;
    }
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
    const nextKey: WorkspaceTreeLoadKey = {
      id: targetWorkspaceId ?? null,
      path: ws?.path,
    };
    if (!shouldReloadWorkspaceTree(this.lastLoadedWorkspaceKey, nextKey, this.initialLoadComplete)) {
      return;
    }
    this.lastLoadedWorkspaceKey = nextKey;
    await this.loadRoot(ws?.path);
  }

  async loadRoot(dirPath?: string): Promise<void> {
    const requestId = ++this.loadRequestId;
    const pathToLoad = dirPath || this.workspaces().find(w => w.id === this.currentWorkspaceId())?.path;
    if (!pathToLoad) {
      this.tree = [];
      this.loadError.set('');
      this.workspaceFileChangeStatus.clear();
      this.rebuildFlat();
      this.initialLoadComplete = false;
      return;
    }

    try {
      const entries = await this.electron.readDirectory(pathToLoad);
      if (requestId !== this.loadRequestId) return;
      this.tree = fileNodesFromDirectoryEntries(entries, 0);
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
    const expandedPaths = collectExpandedPaths(this.tree);
    await this.loadRoot(dirPath);
    if (expandedPaths.size === 0 || this.loadError()) {
      return;
    }

    await this.restoreExpandedPaths(expandedPaths);
  }

  private async applyWorkspaceFileChanges(
    workspaceRoot: string,
    event: WorkspaceFilesChangedMessage,
  ): Promise<void> {
    if (!this.initialLoadComplete || this.loadError()) {
      await this.reloadPreservingExpansion(workspaceRoot);
      return;
    }

    const changes = workspaceFileChangeDescriptorsFromEvent(event);
    if (changes.some((change) => change.relativePath === '.gitignore')) {
      await this.reloadPreservingExpansion(workspaceRoot);
      return;
    }

    const root = normalizeTreeAbsolutePath(workspaceRoot);
    let treeChanged = false;

    for (const change of changes) {
      const absPath =
        change.relativePath === '.'
          ? root
          : joinTreeAbsolutePath(root, change.relativePath);
      const previousAbs = change.previousRelativePath
        ? change.previousRelativePath === '.'
          ? root
          : joinTreeAbsolutePath(root, change.previousRelativePath)
        : null;

      if (change.kind === 'deleted' && removeFileNodeAtPath(this.tree, absPath)) {
        treeChanged = true;
        this.updateTreeSelectionAfterDelete(absPath);
        continue;
      }

      if (
        change.kind === 'renamed' &&
        previousAbs &&
        parentWorkspaceRelativePath(change.previousRelativePath ?? '.') ===
          parentWorkspaceRelativePath(change.relativePath) &&
        renameFileNodeAtPath(
          this.tree,
          previousAbs,
          absPath,
          workspaceFileBasename(change.relativePath),
        )
      ) {
        treeChanged = true;
        this.updateTreeSelectionAfterRename(previousAbs, absPath);
      }
    }

    if (await this.refreshAllExpandedFoldersFromDisk(workspaceRoot)) {
      treeChanged = true;
    }

    if (treeChanged) {
      this.rebuildFlat();
    } else {
      await this.reloadPreservingExpansion(workspaceRoot);
    }
  }

  /** Re-read every expanded folder (and root) from disk — authoritative listing sync. */
  private async refreshAllExpandedFoldersFromDisk(workspaceRoot: string): Promise<boolean> {
    let changed = false;

    try {
      const entries = await this.electron.readDirectory(workspaceRoot);
      this.tree = mergeDirectoryListingIntoChildren(this.tree, entries, 0);
      changed = true;
    } catch {
      // continue with expanded subfolders
    }

    const walk = async (nodes: FileNode[]): Promise<void> => {
      for (const node of nodes) {
        if (!node.isDirectory || !node.expanded) {
          continue;
        }
        try {
          const entries = await this.electron.readDirectory(node.path);
          node.children = mergeDirectoryListingIntoChildren(
            node.children,
            entries,
            node.depth + 1,
          );
          changed = true;
        } catch {
          // keep existing children
        }
        if (node.children && node.children.length > 0) {
          await walk(node.children);
        }
      }
    };

    await walk(this.tree);
    return changed;
  }

  private updateTreeSelectionAfterDelete(deletedPath: string): void {
    const deletedNorm = normalizeTreeAbsolutePath(deletedPath);
    const selected = this.selectedPath();
    if (selected && normalizeTreeAbsolutePath(selected) === deletedNorm) {
      this.selectedPath.set(parentDirectoryPath(deletedPath));
    }
    const renaming = this.inlineRenamePath();
    if (renaming && normalizeTreeAbsolutePath(renaming) === deletedNorm) {
      this.cancelInlineRename();
    }
  }

  private updateTreeSelectionAfterRename(oldPath: string, newPath: string): void {
    const oldNorm = normalizeTreeAbsolutePath(oldPath);
    const selected = this.selectedPath();
    if (selected && normalizeTreeAbsolutePath(selected) === oldNorm) {
      this.selectedPath.set(newPath);
    }
    const renaming = this.inlineRenamePath();
    if (renaming && normalizeTreeAbsolutePath(renaming) === oldNorm) {
      this.inlineRenamePath.set(newPath);
    }
  }

  async onTreeNodeClick(node: FlatNode): Promise<void> {
    if (Date.now() < this.treeInteractionSuppressUntil) {
      return;
    }
    if (this.isTreeNodeInlineEditing(node)) {
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
    if (this.isTreeNodeInlineEditing(node)) {
      return;
    }
    this.selectedPath.set(node.path);
    if (node.isDirectory) {
      return;
    }
    this.workspaceFileOpen.emit({ absolutePath: node.path });
  }

  onTreeKeydown(event: KeyboardEvent): void {
    if (this.pendingCreate() || this.inlineRenamePath()) {
      return;
    }
    const tree = event.currentTarget;
    if (!(tree instanceof HTMLElement) || document.activeElement !== tree) {
      return;
    }
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
            const parentPath = findParentPathInFlatTree(flat, node.path);
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

  private scrollToSelectedNode(): void {
    const selected = this.selectedPath();
    if (!selected) {
      return;
    }
    scrollWorkspaceTreeNodeToSelected(selected);
  }

  async toggleFolder(node: FlatNode): Promise<void> {
    const treeNode = findFileNode(this.tree, node.path);
    if (!treeNode || !treeNode.isDirectory) return;

    if (treeNode.expanded) {
      treeNode.expanded = false;
    } else {
      try {
        const entries = await this.electron.readDirectory(treeNode.path);
        treeNode.children = mergeDirectoryListingIntoChildren(
          treeNode.children,
          entries,
          treeNode.depth + 1,
        );
      } catch {
        treeNode.children = treeNode.children ?? [];
      }
      treeNode.expanded = true;
    }
    this.rebuildFlat();
  }

  private rebuildFlat(): void {
    this.flatTree.set(rebuildFlatTree(this.tree));
  }

  private async restoreExpandedPaths(expandedPaths: Set<string>): Promise<void> {
    const sortedPaths = Array.from(expandedPaths).sort((a, b) => a.length - b.length);
    for (const targetPath of sortedPaths) {
      const node = findFileNodeByNormalizedPath(this.tree, targetPath);
      if (!node || !node.isDirectory) {
        continue;
      }

      try {
        const entries = await this.electron.readDirectory(node.path);
        node.children = mergeDirectoryListingIntoChildren(
          node.children,
          entries,
          node.depth + 1,
        );
      } catch {
        node.children = node.children ?? [];
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
      const node = findFileNodeByNormalizedPath(this.tree, currentPath);
      if (!node || !node.isDirectory) {
        break;
      }

      if (!node.expanded) {
        if (node.children === null) {
          try {
            const entries = await this.electron.readDirectory(node.path);
            node.children = fileNodesFromDirectoryEntries(entries, node.depth + 1);
          } catch {
            node.children = [];
          }
        }
        node.expanded = true;
      }
    }

    this.rebuildFlat();
    scrollWorkspaceTreeNodeToPath(absolutePath);
  }
}
