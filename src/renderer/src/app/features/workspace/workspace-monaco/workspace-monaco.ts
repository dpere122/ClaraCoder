import { CommonModule } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  Injector,
  NgZone,
  output,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import type * as Monaco from 'monaco-editor';
import {
  lspServerKindForWorkspaceRelativePath,
  type MonacoWorkspaceEditorSettings,
  type WorkspaceMonacoEditorScrollState,
  type LspEditorDiagnostic,
} from '@shared/index';
import { normalizeMonacoWorkspaceEditorSettings } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';
import { defineMonacoAppTheme, resolveMonacoThemeName } from '../../../core/theme/monaco-app-theme';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import {
  displayPathForModelKey,
  editorModelKeyForRelativePath,
  isExternalModelKey,
  isTurnDiffModelKey,
  type OpenEditorFileRef,
  relativePathFromModelKey,
} from '../open-editor-file-ref';
import { monacoWorkspaceSettingsToEditorOptions } from './workspace-monaco-editor-options';
import { renderMarkdownDoc } from './markdown-doc-renderer';
import type { EditorSelectionPayload } from '../../chat/chat-context-bar/chat-context-file';
import { invalidateMonacoModelLspDocumentSync, markMonacoModelLspDocumentSynced, monacoModelNeedsLspDocumentSync } from './workspace-monaco-lsp-sync-state';
import { applyLspDiagnosticsToModel } from './workspace-monaco-diagnostics';
import type { EditorOutlineSymbol } from '../editor-outline/editor-outline';
import {
  monacoLanguageIdForPath,
  WorkspaceMonacoModelStore,
  type WorkspaceMonacoModelEvent,
} from './workspace-monaco-model-store';

/** Read-only before/after text for one file a past turn edited (turn-diff tab). */
export interface WorkspaceMonacoReadOnlyDiff {
  /** Turn-diff tab model key; the diff shows while this key is active. */
  modelKey: string;
  relativePath: string;
  /** Short label for the toolbar, e.g. "Turn 3". */
  label: string;
  original: string;
  modified: string;
}

const EDITOR_SELECTION_DEBOUNCE_MS = 50;
const LSP_DIAGNOSTICS_DEBOUNCE_MS = 450;
const LSP_OUTLINE_DEBOUNCE_MS = 450;

let nextOwnerSeq = 0;

/**
 * One Monaco editor surface (one per editor-grid slot).
 *
 * Text models, dirty / detached state and LSP provider registration live in the shared
 * {@link WorkspaceMonacoModelStore}; this component owns only its editor instance, view
 * state, markdown preview and diff surface.
 */
@Component({
  selector: 'app-workspace-monaco',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './workspace-monaco.html',
  styleUrl: './workspace-monaco.css',
  // Markdown preview HTML is injected via [innerHTML]; emulated encapsulation cannot
  // style it. All class names are `workspace-monaco-`/`md-doc-` prefixed to avoid leaks.
  encapsulation: ViewEncapsulation.None,
})
export class WorkspaceMonacoComponent {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly inj = inject(Injector);
  private readonly store = inject(WorkspaceMonacoModelStore);
  private readonly ownerId = `monaco-${++nextOwnerSeq}`;

  /** Absolute workspace root (empty when none). */
  readonly workspacePath = input<string>('');
  /** Active editor model key (`rel:…` or `abs:…`), or null when no file tab is selected. */
  readonly activeModelKey = input<string | null>(null);
  /** Open file tabs Monaco should keep models for. */
  readonly openEditorFiles = input<readonly OpenEditorFileRef[]>([]);
  /** Workspace card id for persisting per-tab scroll state. */
  readonly workspaceId = input<string | null>(null);
  /** Persisted scroll positions for the active workspace (relative path → scroll). */
  readonly persistedScrollByPath = input<Readonly<Record<string, WorkspaceMonacoEditorScrollState>>>({});
  /** Active file as POSIX relative path, or null when the conversation tab is selected. */
  readonly relativePath = input<string | null>(null);
  /** Relative paths of all open file tabs; models for closed tabs are disposed. */
  readonly openFileRelativePaths = input<readonly string[]>([]);
  /** Persisted Monaco options from app config (optional until loaded). */
  readonly editorSettings = input<MonacoWorkspaceEditorSettings | null | undefined>(undefined);
  /** Before/after content for the active turn-diff tab (read-only diff surface). */
  readonly readOnlyDiff = input<WorkspaceMonacoReadOnlyDiff | null>(null);
  readonly conversationId = input<string | null>(null);
  /** After cross-file go-to-definition: reveal cursor once this path is the active editor model. */
  readonly pendingEditorReveal = input<{ relativePath: string; line: number; column: number } | null>(null);
  /** Model keys that should open in markdown preview and hide the edit/preview toggle. */
  readonly forcePreviewForKeys = input<ReadonlySet<string> | readonly string[]>([]);
  /** Live build-plan markdown while the planner streams (full content replacement). */
  readonly buildPlanLiveContent = input<{ relativePath: string; content: string } | null>(null);
  /** Model keys receiving live build-plan chunks — skip disk reload while streaming. */
  readonly buildPlanStreamingKeys = input<ReadonlySet<string> | readonly string[]>([]);
  /**
   * True for the editor-grid slot that owns keyboard focus. Only the focused instance
   * reports selection / outline / diagnostics to the shell and drives the LSP watch.
   */
  readonly focused = input<boolean>(true);

  private readonly buildPlanStreamingKeySet = computed(() => {
    const raw = this.buildPlanStreamingKeys();
    if (raw instanceof Set) {
      return raw;
    }
    return new Set(raw);
  });
  /** Cross-file definition navigation (shell opens/focuses tab; optional reveal via {@link pendingEditorReveal}). */
  readonly navigateWorkspaceFile = output<{ relativePath: string; line: number; column: number }>();
  readonly pendingEditorRevealHandled = output<void>();
  /** Non-empty editor text selection in a workspace file (null when cleared or unavailable). */
  readonly editorSelectionChange = output<EditorSelectionPayload | null>();
  /** Document outline symbols for the active editor tab (sidebar outline panel). */
  readonly outlineSymbolsChange = output<{
    relativePath: string | null;
    symbols: readonly EditorOutlineSymbol[];
  }>();
  /** LSP diagnostics for the active editor tab (terminal dock Problems tab). */
  readonly diagnosticsChange = output<{
    relativePath: string | null;
    diagnostics: readonly LspEditorDiagnostic[];
  }>();
  /** Pointer / keyboard activity inside this editor surface (grid focus tracking). */
  readonly surfaceFocused = output<void>();

  protected readonly loadError = signal('');
  protected readonly detachedBanner = signal('');
  /** True while the active tab is a turn-diff tab whose content has loaded. */
  protected readonly monacoDiffActive = computed(() => {
    const diff = this.readOnlyDiff();
    const key = this.activeModelKey()?.trim();
    return !!diff && !!key && diff.modelKey === key;
  });

  private readonly editorHost = viewChild.required<ElementRef<HTMLElement>>('editorHost');
  private readonly diffHost = viewChild.required<ElementRef<HTMLElement>>('diffHost');
  private readonly previewHost = viewChild.required<ElementRef<HTMLElement>>('previewHost');

  /** True while the rendered markdown preview pane replaces the editor pane. */
  protected readonly mdPreviewActive = signal(false);
  /** Sanitized preview HTML (DOMPurify in {@link renderMarkdownDoc}; Angular sanitizer bypassed). */
  protected readonly mdPreviewHtml = signal<SafeHtml>('');
  protected readonly isMarkdownFile = computed(() => {
    const key = this.activeModelKey()?.trim();
    if (!key || isTurnDiffModelKey(key)) {
      return false;
    }
    const path = displayPathForModelKey(key);
    return path.toLowerCase().endsWith('.md');
  });
  protected readonly activePreviewOnly = computed(() => this.isForcePreviewKey(this.activeModelKey()?.trim() ?? ''));
  protected readonly showMdToolbar = computed(
    () => this.isMarkdownFile() && !this.monacoDiffActive() && !this.activePreviewOnly(),
  );
  /** Session-scoped view-mode memory per file (default: edit). */
  private readonly mdViewModeByPath = new Map<string, 'edit' | 'preview'>();
  private mdPreviewContentDisposable: Monaco.IDisposable | null = null;
  private mdPreviewRenderTimer: number | null = null;

  private readonly themeEngine = inject(ThemeEngineService);
  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;

  /** Monaco theme name for the persisted setting; `follow-app` uses the engine-derived palette. */
  private monacoThemeName(settings: MonacoWorkspaceEditorSettings): string {
    return resolveMonacoThemeName(settings.theme, this.themeEngine.monacoTheme() !== null, this.themeEngine.mode());
  }
  private editorSelectionDisposable: Monaco.IDisposable | null = null;
  private editorSelectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private editorContentDisposable: Monaco.IDisposable | null = null;
  /** Editor-scoped actions (save, format) registered via `addAction`; disposed with the instance. */
  private editorActionDisposables: Monaco.IDisposable[] = [];
  private diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private diffOriginalModel: Monaco.editor.ITextModel | null = null;
  private diffModifiedModel: Monaco.editor.ITextModel | null = null;
  /** Turn-diff model key of the mounted diff surface. */
  private diffMountedKey = '';

  private readonly editorReady = signal(false);
  /** Model keys this instance currently owns in the shared store. */
  private ownedKeys = new Set<string>();
  /** In-session Monaco view state per open file (scroll + cursor). */
  private readonly viewStateByPath = new Map<string, Monaco.editor.ICodeEditorViewState>();
  private lastActiveEditorPath: string | null = null;
  private lastScrollPersistWorkspaceId: string | null = null;
  private scrollPersistTimer: number | null = null;
  private pendingScrollPersist: {
    workspaceId: string;
    key: string;
    scrollTop: number;
    scrollLeft: number;
  } | null = null;
  private lspDiagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lspDiagnosticsUnsubscribe: (() => void) | null = null;
  private lastLspDiagnosticsGeneration = -1;
  private lastLspDiagnosticsEpoch = -1;
  private lastLspDiagnosticsWatchKey = '';
  private readonly activeDiagnostics = signal<readonly LspEditorDiagnostic[]>([]);
  private lspOutlineDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private lastEmittedDiagnosticsRelativePath: string | null | undefined;

  constructor() {
    afterNextRender(() => void this.bootstrapEditor());

    // App theme → Monaco: (re)define the derived palette whenever the theme changes and
    // switch to it when the Editor setting is `follow-app`.
    effect(() => {
      const def = this.themeEngine.monacoTheme();
      const ready = this.editorReady();
      const cfg = this.editorSettings();
      const monacoApi = this.monaco;
      if (!def || !ready || !monacoApi) {
        return;
      }
      untracked(() => {
        defineMonacoAppTheme(monacoApi, def);
        const { settings } = normalizeMonacoWorkspaceEditorSettings(cfg == null ? undefined : cfg);
        monacoApi.editor.setTheme(this.monacoThemeName(settings));
      });
    });

    // Shared context every instance pushes into the store (all slots share one workspace).
    effect(() => this.store.setWorkspaceRoot(this.workspacePath() ?? ''));
    effect(() => this.store.setConversationId(this.conversationId()));
    effect(() => this.store.setEditorSettings(this.editorSettings()));
    effect(() => this.store.setBuildPlanStreamingKeys(this.buildPlanStreamingKeySet()));

    effect(() => {
      const rel = this.relativePath();
      const ready = this.editorReady();
      untracked(() => {
        const next = rel?.trim() ? normalizePathSlashes(rel.trim()) : null;
        if (ready && this.lastActiveEditorPath && this.lastActiveEditorPath !== next) {
          this.captureEditorViewStateForPath(this.lastActiveEditorPath);
        }
        this.lastActiveEditorPath = next;
      });
    });

    effect(() => {
      const refs = this.openEditorFiles();
      if (!this.monaco) {
        return;
      }
      untracked(() => this.syncOwnedModels(refs));
    });

    effect(() => {
      const wsId = this.workspaceId()?.trim() ?? null;
      untracked(() => {
        const prev = this.lastScrollPersistWorkspaceId;
        if (prev && wsId !== prev) {
          if (this.lastActiveEditorPath && this.editorReady()) {
            this.captureEditorViewStateForPath(this.lastActiveEditorPath, prev);
          }
          void this.flushPendingScrollPersist(prev);
        }
        this.lastScrollPersistWorkspaceId = wsId;
      });
    });

    effect(() => {
      const key = this.activeModelKey()?.trim();
      const root = this.workspacePath()?.trim();
      const ready = this.editorReady();
      const diffOn = this.monacoDiffActive();
      const diff = this.readOnlyDiff();
      const ed = this.editor;
      const monacoApi = this.monaco;
      if (!ready || !ed || !monacoApi) {
        return;
      }
      if (!key || !root) {
        untracked(() => {
          this.loadError.set('');
          this.detachedBanner.set('');
        });
        return;
      }
      if (diffOn && diff) {
        untracked(() => this.mountOrUpdateDiffEditor(diff));
      } else if (isTurnDiffModelKey(key)) {
        // Turn-diff content is still loading: no workspace model exists for this key.
        untracked(() => this.disposeDiffSurface());
      } else {
        untracked(() => {
          this.disposeDiffSurface();
          void this.syncActiveModel(key);
        });
      }
    });

    effect(() => {
      const key = this.activeModelKey()?.trim();
      const rel = this.relativePath()?.trim();
      const isFocused = this.focused();
      if (key && rel) {
        return;
      }
      untracked(() => {
        this.setActiveDiagnostics(null, []);
        this.lastLspDiagnosticsWatchKey = '';
        this.lastLspDiagnosticsGeneration = -1;
        this.lastLspDiagnosticsEpoch = -1;
        if (isFocused) {
          this.electron.lspDiagnosticsWatchStop();
        }
      });
    });

    // Focus hand-off between grid slots: the newly focused instance re-publishes its
    // selection / outline / diagnostics so shell panels reflect the active editor.
    effect(() => {
      const isFocused = this.focused();
      const ready = this.editorReady();
      untracked(() => {
        if (!ready || !this.editor) {
          return;
        }
        if (isFocused) {
          this.store.setFocusedEditor(this.editor);
          this.publishCachedDiagnosticsForActiveEditor();
          void this.refreshActiveLspDiagnostics(true);
          void this.refreshOutlineSymbols();
          this.emitEditorSelectionFromActiveEditor();
        } else {
          this.store.clearFocusedEditorIf(this.editor);
        }
      });
    });

    effect(() => {
      const cfg = this.editorSettings();
      const ready = this.editorReady();
      const ed = this.editor;
      const monacoApi = this.monaco;
      if (!ready || !ed || !monacoApi) {
        return;
      }
      const { settings } = normalizeMonacoWorkspaceEditorSettings(cfg == null ? undefined : cfg);
      untracked(() => {
        const mapped = monacoWorkspaceSettingsToEditorOptions(settings);
        ed.updateOptions(mapped);
        if (this.diffEditor) {
          const { theme: _t, ...diffOpts } = mapped as Record<string, unknown>;
          this.diffEditor.updateOptions(diffOpts as Monaco.editor.IDiffEditorConstructionOptions);
        }
        monacoApi.editor.setTheme(this.monacoThemeName(settings));
      });
    });

    // The diff surface wins over markdown preview: showing a diff force-exits preview
    // and resets the remembered mode so the diff is never obscured.
    effect(() => {
      if (!this.monacoDiffActive()) {
        return;
      }
      untracked(() => {
        const key = this.activeModelKey()?.trim();
        if (key) {
          this.mdViewModeByPath.set(key, 'edit');
        }
        this.exitMdPreview(false);
      });
    });

    effect(() => {
      const previewOnly = this.activePreviewOnly();
      const ready = this.editorReady();
      const diffOn = this.monacoDiffActive();
      const key = this.activeModelKey()?.trim();
      if (!previewOnly || !ready || diffOn || !key || !this.isMarkdownFile()) {
        return;
      }
      untracked(() => {
        this.mdViewModeByPath.set(key, 'preview');
        this.enterMdPreview(key);
      });
    });

    effect(() => {
      const live = this.buildPlanLiveContent();
      const key = this.activeModelKey()?.trim();
      const ready = this.editorReady();
      if (!live || !key || !ready) {
        return;
      }
      const livePath = normalizePathSlashes(live.relativePath.trim());
      const activeRel = relativePathFromModelKey(key);
      if (!activeRel || normalizePathSlashes(activeRel) !== livePath) {
        return;
      }
      untracked(() => this.store.setModelContentSynced(key, live.content));
    });

    this.store.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((ev) => this.onStoreEvent(ev));
    this.store.navigateWorkspaceFile$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      if (this.focused()) {
        this.zone.run(() => this.emitOutput(this.navigateWorkspaceFile, p));
      }
    });

    effect(() => {
      const pending = this.pendingEditorReveal();
      const key = this.activeModelKey()?.trim();
      const rel = key ? relativePathFromModelKey(key) : null;
      const ready = this.editorReady();
      const ed = this.editor;
      const diffOn = this.monacoDiffActive();
      if (!pending || !rel?.trim() || !key || !ready || !ed || diffOn) {
        return;
      }
      if (normalizePathSlashes(rel) !== normalizePathSlashes(pending.relativePath)) {
        return;
      }
      untracked(() => {
        requestAnimationFrame(() => {
          ed.setPosition({ lineNumber: pending.line, column: pending.column });
          ed.revealLineInCenter(pending.line);
          this.zone.run(() => this.emitOutputVoid(this.pendingEditorRevealHandled));
        });
      });
    });

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.lspDiagnosticsUnsubscribe?.();
      this.lspDiagnosticsUnsubscribe = null;
      if (this.lspDiagnosticsDebounceTimer != null) {
        clearTimeout(this.lspDiagnosticsDebounceTimer);
        this.lspDiagnosticsDebounceTimer = null;
      }
      if (this.lspOutlineDebounceTimer != null) {
        clearTimeout(this.lspOutlineDebounceTimer);
        this.lspOutlineDebounceTimer = null;
      }
      this.lastLspDiagnosticsWatchKey = '';
      this.lastLspDiagnosticsGeneration = -1;
      this.lastLspDiagnosticsEpoch = -1;
      if (this.focused()) {
        this.electron.lspDiagnosticsWatchStop();
      }
      this.mdPreviewContentDisposable?.dispose();
      this.mdPreviewContentDisposable = null;
      if (this.mdPreviewRenderTimer != null) {
        clearTimeout(this.mdPreviewRenderTimer);
        this.mdPreviewRenderTimer = null;
      }
      this.disposeDiffSurface();
      this.viewStateByPath.clear();
      this.disposeEditorSelectionListener();
      this.editorContentDisposable?.dispose();
      this.editorContentDisposable = null;
      for (const d of this.editorActionDisposables) {
        d.dispose();
      }
      this.editorActionDisposables = [];
      this.store.clearFocusedEditorIf(this.editor);
      // Detach before releasing so a shared model is never disposed while still attached here.
      this.editor?.setModel(null);
      this.store.releaseOwner(this.ownerId);
      this.ownedKeys.clear();
      this.editor?.dispose();
      this.editor = null;
      this.monaco = null;
    });
  }

  /** Skip output emits after teardown (avoids NG0953 from async LSP / Monaco callbacks). */
  private emitOutput<T>(output: { emit(value: T): void }, value: T): void {
    if (this.destroyed) {
      return;
    }
    output.emit(value);
  }

  private emitOutputVoid(output: { emit(): void }): void {
    if (this.destroyed) {
      return;
    }
    output.emit();
  }

  /** Sync this instance's owned model keys with the store; releases models for closed tabs. */
  private syncOwnedModels(refs: readonly OpenEditorFileRef[]): void {
    const next = new Set(refs.map((r) => r.modelKey).filter(Boolean));
    for (const key of this.ownedKeys) {
      if (next.has(key)) {
        continue;
      }
      const model = this.store.getModel(key);
      if (model && this.editor?.getModel() === model) {
        const activeRel = relativePathFromModelKey(key);
        if (activeRel) {
          this.captureEditorViewStateForPath(normalizePathSlashes(activeRel));
        }
        this.editor.setModel(null);
      }
      const closedRel = relativePathFromModelKey(key);
      if (closedRel) {
        this.viewStateByPath.delete(normalizePathSlashes(closedRel));
      }
      this.mdViewModeByPath.delete(key);
    }
    this.store.syncOwner(this.ownerId, refs);
    this.ownedKeys = next;
  }

  private onStoreEvent(ev: WorkspaceMonacoModelEvent): void {
    const activeKey = this.activeModelKey()?.trim() ?? '';
    switch (ev.type) {
      case 'reloaded':
        if (ev.modelKey === activeKey) {
          this.zone.run(() => {
            this.loadError.set('');
            this.detachedBanner.set('');
          });
          if (this.focused()) {
            this.scheduleLspDiagnosticsRefresh();
          }
        }
        break;
      case 'detached':
        if (ev.modelKey === activeKey) {
          this.zone.run(() => this.updateDetachedBanner(ev.modelKey));
        }
        break;
      case 'retargeted': {
        const mdMode = this.mdViewModeByPath.get(ev.fromKey);
        if (mdMode) {
          this.mdViewModeByPath.set(ev.toKey, mdMode);
          this.mdViewModeByPath.delete(ev.fromKey);
        }
        if (this.ownedKeys.has(ev.fromKey)) {
          this.ownedKeys.delete(ev.fromKey);
          this.ownedKeys.add(ev.toKey);
        }
        if (ev.fromKey === activeKey) {
          this.zone.run(() => this.detachedBanner.set(''));
        }
        break;
      }
      case 'loadError':
        if (ev.modelKey === activeKey) {
          this.zone.run(() => this.loadError.set(ev.message));
        }
        break;
    }
  }

  @HostListener('pointerdown')
  protected onHostPointerDown(): void {
    this.emitOutputVoid(this.surfaceFocused);
  }

  @HostListener('focusin')
  protected onHostFocusIn(): void {
    this.emitOutputVoid(this.surfaceFocused);
  }

  @HostListener('keydown', ['$event'])
  protected onKeydown(ev: KeyboardEvent): void {
    // Ctrl/Cmd+S anywhere in this slot (markdown preview, banners, focus outside the Monaco
    // textarea). When the editor's own save action already handled the chord it called
    // preventDefault, so skip to avoid saving twice.
    if (this.isSaveKey(ev)) {
      if (!ev.defaultPrevented) {
        ev.preventDefault();
        void this.saveCurrent();
      }
      return;
    }
    // Fallback when Chromium/Electron does not intercept Find (browser preview, or
    // focus inside this host but outside the Monaco textarea — common on Linux).
    if (this.isPrimaryFindKey(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      this.openFindWidget();
      return;
    }
  }

  /**
   * Opens Monaco's find widget, focusing the active code/diff editor first.
   * Used when Ctrl/Cmd+F arrives via host keydown or main-process IPC (Wayland/Electron).
   */
  openFindWidget(): void {
    if (this.mdPreviewActive()) {
      this.previewHost().nativeElement.focus();
      return;
    }
    if (this.monacoDiffActive()) {
      const modified = this.diffEditor?.getModifiedEditor();
      if (!modified?.getModel()) {
        return;
      }
      modified.focus();
      // Defer so a concurrent setModel (tab sync) cannot race FindWidget construction.
      // Monaco registers Find as `actions.find` (not `editor.action.startFindAction`).
      queueMicrotask(() => this.runEditorFindAction(modified));
      return;
    }
    const ed = this.editor;
    if (!ed?.getModel()) {
      return;
    }
    ed.focus();
    // Defer so a concurrent setModel (tab sync) cannot race FindWidget construction.
    queueMicrotask(() => this.runEditorFindAction(ed));
  }

  /** Monaco's StartFindAction id is `actions.find` (see FIND_IDS.StartFindAction). */
  private runEditorFindAction(ed: Monaco.editor.ICodeEditor): void {
    const action = ed.getAction('actions.find');
    if (action) {
      void action.run();
      return;
    }
    // Fallback if the contribution action map is unavailable.
    ed.trigger('clara', 'actions.find', null);
  }

  private isPrimaryFindKey(ev: KeyboardEvent): boolean {
    if (ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== 'f') {
      return false;
    }
    return ev.ctrlKey || ev.metaKey;
  }

  private isSaveKey(ev: KeyboardEvent): boolean {
    if (ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== 's') {
      return false;
    }
    return ev.ctrlKey || ev.metaKey;
  }

  protected setMdViewMode(mode: 'edit' | 'preview'): void {
    const key = this.activeModelKey()?.trim();
    if (!key || !this.isMarkdownFile() || this.isForcePreviewKey(key)) {
      return;
    }
    this.mdViewModeByPath.set(key, mode);
    if (mode === 'preview') {
      this.enterMdPreview(key);
    } else {
      this.exitMdPreview(true);
    }
  }

  /** Shows the rendered preview for {@param key} and keeps it live against model changes. */
  private enterMdPreview(key: string, attempt = 0): void {
    const model = this.store.getModel(key);
    if (!model) {
      // The activePreviewOnly effect can fire before syncActiveModel finishes creating the
      // model (the store map is not reactive). Retry a few frames so the preview
      // still enters once the model lands.
      if (attempt < 4 && this.activePreviewOnly()) {
        afterNextRender(() => this.enterMdPreview(key, attempt + 1), { injector: this.inj });
      }
      return;
    }
    const ratio = this.editorScrollRatio();
    this.renderMdPreview(key);
    this.mdPreviewActive.set(true);

    // Live re-render: covers typing (n/a while hidden) and external file changes
    // reloading the model via the store's workspaceFilesChanged$ handling.
    this.mdPreviewContentDisposable?.dispose();
    this.mdPreviewContentDisposable = model.onDidChangeContent(() => this.scheduleMdPreviewRerender(key));

    requestAnimationFrame(() => {
      const el = this.previewHost().nativeElement;
      this.applyScrollRatio(el, ratio);
      el.focus();
    });
  }

  /** @param syncBackToEditor map preview scroll position onto the editor and refocus it. */
  private exitMdPreview(syncBackToEditor: boolean): void {
    if (this.mdPreviewRenderTimer != null) {
      clearTimeout(this.mdPreviewRenderTimer);
      this.mdPreviewRenderTimer = null;
    }
    this.mdPreviewContentDisposable?.dispose();
    this.mdPreviewContentDisposable = null;
    if (!this.mdPreviewActive()) {
      return;
    }
    const ed = this.editor;
    const el = this.previewHost().nativeElement;
    const range = el.scrollHeight - el.clientHeight;
    const ratio = range > 0 ? Math.min(1, Math.max(0, el.scrollTop / range)) : 0;
    this.mdPreviewActive.set(false);
    if (syncBackToEditor && ed) {
      requestAnimationFrame(() => {
        const edRange = ed.getScrollHeight() - ed.getLayoutInfo().height;
        ed.setScrollTop(edRange > 0 ? ratio * edRange : 0);
        ed.focus();
      });
    }
  }

  private scheduleMdPreviewRerender(key: string): void {
    if (this.mdPreviewRenderTimer != null) {
      clearTimeout(this.mdPreviewRenderTimer);
    }
    this.mdPreviewRenderTimer = window.setTimeout(() => {
      this.mdPreviewRenderTimer = null;
      this.zone.run(() => {
        if (!this.mdPreviewActive()) {
          return;
        }
        const el = this.previewHost().nativeElement;
        const prevScrollTop = el.scrollTop;
        this.renderMdPreview(key);
        requestAnimationFrame(() => {
          el.scrollTop = prevScrollTop;
        });
      });
    }, 150);
  }

  private renderMdPreview(key: string): void {
    const model = this.store.getModel(key);
    const root = this.workspacePath()?.trim();
    if (!model || !root) {
      return;
    }
    const rel = relativePathFromModelKey(key) ?? displayPathForModelKey(key);
    const html = renderMarkdownDoc(model.getValue(), { workspaceRoot: root, fileRelativePath: rel });
    this.mdPreviewHtml.set(this.sanitizer.bypassSecurityTrustHtml(html));
  }

  /** Scrolled fraction of the editor in [0, 1] (0 when content fits the viewport). */
  private editorScrollRatio(): number {
    const ed = this.editor;
    if (!ed) {
      return 0;
    }
    const range = ed.getScrollHeight() - ed.getLayoutInfo().height;
    if (range <= 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, ed.getScrollTop() / range));
  }

  private applyScrollRatio(el: HTMLElement, ratio: number): void {
    const range = el.scrollHeight - el.clientHeight;
    el.scrollTop = range > 0 ? ratio * range : 0;
  }

  private isForcePreviewKey(modelKey: string): boolean {
    if (!modelKey) {
      return false;
    }
    const keys = this.forcePreviewForKeys();
    if (keys instanceof Set) {
      return keys.has(modelKey);
    }
    return (keys as readonly string[]).includes(modelKey);
  }

  private updateDetachedBanner(modelKey: string): void {
    if (this.activeModelKey()?.trim() === modelKey) {
      this.detachedBanner.set('This file no longer exists at this path. Save to choose a location.');
      this.loadError.set('');
    }
  }

  private async bootstrapEditor(): Promise<void> {
    const monacoApi = await import('monaco-editor');
    const { ensureMonacoFindWidgetSafe } = await import('../../../../monaco-find-safety');
    const { ensureMonacoHoverDelegateSafe } = await import('../../../../monaco-hover-delegate-safety');
    await ensureMonacoFindWidgetSafe();
    await ensureMonacoHoverDelegateSafe();
    if (this.destroyed) {
      return;
    }
    this.monaco = monacoApi;
    this.store.setMonaco(monacoApi);
    // Monaco's in-worker TS/JS service has no workspace fs/tsconfig; semantic rules
    // clash with the real project. TS/JS IntelliSense and checks come from the LSP bridge.
    monacoApi.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSuggestionDiagnostics: true,
    });
    monacoApi.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSuggestionDiagnostics: true,
    });
    // Built-in TS/JS worker features duplicate LSP bridge results — disable IntelliSense in worker.
    const tsDefaults = monacoApi.languages.typescript.typescriptDefaults;
    const jsDefaults = monacoApi.languages.typescript.javascriptDefaults;
    const lspOnlyMode = {
      ...tsDefaults.modeConfiguration,
      hovers: false,
      documentHighlights: false,
      definitions: false,
      references: false,
      completions: false,
      diagnostics: false,
      signatureHelp: false,
      rename: false,
      codeActions: false,
    };
    tsDefaults.setModeConfiguration(lspOnlyMode);
    jsDefaults.setModeConfiguration(lspOnlyMode);
    const host = this.editorHost().nativeElement;
    const { settings } = normalizeMonacoWorkspaceEditorSettings(this.editorSettings() == null ? undefined : this.editorSettings()!);
    const mapped = monacoWorkspaceSettingsToEditorOptions(settings);
    // Monaco standalone only honors the dotted global-style key (see monaco-editor#1833);
    // `semanticHighlighting: true` is ignored and semantic tokens are never painted.
    const appTheme = this.themeEngine.monacoTheme();
    if (appTheme) {
      defineMonacoAppTheme(monacoApi, appTheme);
    }
    const editorOptions = {
      ...mapped,
      theme: this.monacoThemeName(settings),
      automaticLayout: true,
      'semanticHighlighting.enabled': true,
    } as Monaco.editor.IStandaloneEditorConstructionOptions & {
      'semanticHighlighting.enabled'?: boolean;
    };
    this.editor = monacoApi.editor.create(host, editorOptions);
    await ensureMonacoHoverDelegateSafe();
    // `addAction` (not `addCommand`): actions are scoped to this editor via the `editorId`
    // context key and return a disposable. `addCommand` registers a global keybinding that is
    // never disposed, so with several grid slots the most recently created (or an already
    // destroyed) instance would win Ctrl+S and silently save the wrong slot.
    this.editorActionDisposables.push(
      this.editor.addAction({
        id: 'clara-save-file',
        label: 'Save File',
        keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS],
        run: () => {
          void this.saveCurrent();
        },
      }),
      this.editor.addAction({
        id: 'clara-format-document',
        label: 'Format Document',
        keybindings: [monacoApi.KeyMod.Shift | monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyF],
        run: (ed) => {
          void ed.getAction('editor.action.formatDocument')?.run();
        },
      }),
    );
    this.wireEditorSelectionListener();
    this.editor.onDidScrollChange(() => this.onEditorScrollChanged());
    this.editor.onDidChangeModel(() => {
      this.publishCachedDiagnosticsForActiveEditor();
      void this.refreshActiveLspDiagnostics(true);
      void this.refreshOutlineSymbols();
    });
    this.editorContentDisposable = this.editor.onDidChangeModelContent(() => {
      this.scheduleLspDiagnosticsRefresh();
      this.scheduleOutlineRefresh();
    });
    this.editor.onDidFocusEditorWidget(() => this.zone.run(() => this.emitOutputVoid(this.surfaceFocused)));
    this.store.ensureLspRegistered(monacoApi);
    this.lspDiagnosticsUnsubscribe = this.electron.onLspDiagnosticsUpdated((payload) => {
      if (!this.focused()) {
        return;
      }
      const rel = this.relativePath()?.trim();
      if (!rel || normalizePathSlashes(rel) !== normalizePathSlashes(payload.relativePath)) {
        return;
      }
      const epoch = payload.epoch ?? 0;
      if (payload.generation === this.lastLspDiagnosticsGeneration && epoch === this.lastLspDiagnosticsEpoch) {
        return;
      }
      const model = this.editor?.getModel();
      const dirty = !!(model && this.modelIsDirtyRelativeToDisk());
      const epochChanged = epoch !== this.lastLspDiagnosticsEpoch;
      const generationRewound = payload.generation < this.lastLspDiagnosticsGeneration;
      if (model && (generationRewound || (epochChanged && dirty))) {
        invalidateMonacoModelLspDocumentSync(model);
      }
      void this.refreshActiveLspDiagnostics(dirty);
    });
    if (this.focused()) {
      this.store.setFocusedEditor(this.editor);
    }
    this.syncOwnedModels(this.openEditorFiles());
    this.editorReady.set(true);
    void this.refreshActiveLspDiagnostics(true);
    void this.refreshOutlineSymbols();
  }

  /** Conversation id gates LSP; when a workspace is open without chat, IntelliSense stays off. */
  private lspSessionId(): string | null {
    return this.conversationId()?.trim() || null;
  }

  private modelIsDirtyRelativeToDisk(): boolean {
    const key = this.activeModelKey()?.trim();
    return !!key && this.store.isKeyDirty(key);
  }

  private scheduleLspDiagnosticsRefresh(): void {
    if (this.lspDiagnosticsDebounceTimer != null) {
      clearTimeout(this.lspDiagnosticsDebounceTimer);
    }
    this.lspDiagnosticsDebounceTimer = setTimeout(() => {
      this.lspDiagnosticsDebounceTimer = null;
      void this.refreshActiveLspDiagnostics(false);
    }, LSP_DIAGNOSTICS_DEBOUNCE_MS);
  }

  private async refreshActiveLspDiagnostics(forceSync: boolean): Promise<void> {
    if (!this.focused()) {
      // Unfocused slots never touch the shared diagnostics watch or shell state.
      return;
    }
    const monacoApi = this.monaco;
    const ed = this.editor;
    const sid = this.lspSessionId();
    const rel = this.relativePath()?.trim();
    if (!monacoApi || !ed || !sid || !rel || !lspServerKindForWorkspaceRelativePath(rel)) {
      this.setActiveDiagnostics(null, []);
      this.lastLspDiagnosticsWatchKey = '';
      this.lastLspDiagnosticsGeneration = -1;
      this.lastLspDiagnosticsEpoch = -1;
      this.electron.lspDiagnosticsWatchStop();
      return;
    }
    const model = ed.getModel();
    const modelKey = this.activeModelKey()?.trim();
    if (!model || !modelKey || model.uri.scheme !== 'clara-workspace') {
      this.setActiveDiagnostics(null, []);
      this.lastLspDiagnosticsWatchKey = '';
      this.lastLspDiagnosticsGeneration = -1;
      this.lastLspDiagnosticsEpoch = -1;
      this.electron.lspDiagnosticsWatchStop();
      return;
    }
    const requestRel = normalizePathSlashes(rel);
    const requestKey = modelKey;
    const watchKey = `${sid}\0${requestRel}`;
    if (watchKey !== this.lastLspDiagnosticsWatchKey) {
      this.lastLspDiagnosticsWatchKey = watchKey;
      this.lastLspDiagnosticsGeneration = -1;
      this.lastLspDiagnosticsEpoch = -1;
    }
    this.electron.lspDiagnosticsWatchStart(sid, rel);
    const skipSync = !forceSync && !monacoModelNeedsLspDocumentSync(model);
    let res = await this.electron.lspEditorDiagnostics(
      sid,
      rel,
      skipSync ? '' : model.getValue(),
      skipSync,
    );
    if (res.ok && res.syncedFromDisk && skipSync) {
      invalidateMonacoModelLspDocumentSync(model);
      res = await this.electron.lspEditorDiagnostics(sid, rel, model.getValue(), false);
    }
    if (!res.ok) {
      return;
    }
    const activeRel = this.relativePath()?.trim();
    const activeKey = this.activeModelKey()?.trim();
    if (
      !this.focused()
      || !activeRel
      || !activeKey
      || activeKey !== requestKey
      || normalizePathSlashes(activeRel) !== requestRel
    ) {
      return;
    }
    const liveModel = ed.getModel();
    if (!liveModel || liveModel !== model) {
      return;
    }
    if (!skipSync || res.syncedFromDisk) {
      markMonacoModelLspDocumentSynced(model);
    }
    this.store.diagnosticsByModelKey.set(modelKey, [...res.diagnostics]);
    this.lastLspDiagnosticsGeneration = res.generation;
    this.lastLspDiagnosticsEpoch = res.epoch ?? 0;
    applyLspDiagnosticsToModel(monacoApi, model, res.diagnostics);
    this.zone.run(() => this.setActiveDiagnostics(normalizePathSlashes(rel), [...res.diagnostics]));
  }

  /**
   * Immediately hand the Problems panel to this editor before the async LSP refresh completes.
   * A forced emit is required when returning to a previously focused clean file: this component's
   * local empty-state dedupe cannot know that another grid slot has since published diagnostics.
   */
  private publishCachedDiagnosticsForActiveEditor(): void {
    if (this.destroyed || !this.focused()) {
      return;
    }
    const rel = this.relativePath()?.trim();
    const modelKey = this.activeModelKey()?.trim();
    const model = this.editor?.getModel();
    if (
      !rel
      || !modelKey
      || !lspServerKindForWorkspaceRelativePath(rel)
      || !model
      || this.store.getModel(modelKey) !== model
    ) {
      this.zone.run(() => this.setActiveDiagnostics(null, [], true));
      return;
    }
    const cached = this.store.diagnosticsByModelKey.get(modelKey) ?? [];
    this.zone.run(() =>
      this.setActiveDiagnostics(normalizePathSlashes(rel), [...cached], true),
    );
  }

  private setActiveDiagnostics(
    relativePath: string | null,
    diagnostics: readonly LspEditorDiagnostic[],
    force = false,
  ): void {
    if (this.destroyed || !this.focused()) {
      return;
    }
    if (
      !force
      &&
      relativePath === this.lastEmittedDiagnosticsRelativePath
      && diagnostics.length === 0
      && this.activeDiagnostics().length === 0
    ) {
      return;
    }
    this.lastEmittedDiagnosticsRelativePath = relativePath;
    this.activeDiagnostics.set(diagnostics);
    this.emitOutput(this.diagnosticsChange, { relativePath, diagnostics });
  }

  private setOutlineSymbols(relativePath: string | null, symbols: readonly EditorOutlineSymbol[]): void {
    if (!this.focused()) {
      return;
    }
    this.emitOutput(this.outlineSymbolsChange, { relativePath, symbols });
  }

  private scheduleOutlineRefresh(): void {
    if (this.lspOutlineDebounceTimer != null) {
      clearTimeout(this.lspOutlineDebounceTimer);
    }
    this.lspOutlineDebounceTimer = setTimeout(() => {
      this.lspOutlineDebounceTimer = null;
      void this.refreshOutlineSymbols();
    }, LSP_OUTLINE_DEBOUNCE_MS);
  }

  private async refreshOutlineSymbols(): Promise<void> {
    if (!this.focused()) {
      return;
    }
    const sid = this.lspSessionId();
    const rel = this.relativePath()?.trim();
    const ed = this.editor;
    if (!sid || !rel || !ed || !lspServerKindForWorkspaceRelativePath(rel)) {
      this.zone.run(() => this.setOutlineSymbols(null, []));
      return;
    }
    const model = ed.getModel();
    if (!model) {
      return;
    }
    const normalizedRel = normalizePathSlashes(rel);
    const skip = !monacoModelNeedsLspDocumentSync(model);
    const res = await this.electron.lspEditorDocumentSymbols(sid, rel, skip ? '' : model.getValue(), skip);
    if (!res.ok) {
      this.zone.run(() => this.setOutlineSymbols(normalizedRel, []));
      return;
    }
    this.zone.run(() => this.setOutlineSymbols(normalizedRel, res.hierarchical ?? []));
  }

  /** Jump to a diagnostic range in the active editor (Problems tab). */
  revealDiagnostic(d: LspEditorDiagnostic): void {
    const ed = this.editor;
    const monacoApi = this.monaco;
    if (!ed || !monacoApi) {
      return;
    }
    const range = new monacoApi.Range(d.line, d.character, d.end_line || d.line, d.end_character || d.character + 1);
    ed.setSelection(range);
    ed.revealRangeInCenter(range);
  }

  private disposeEditorSelectionListener(): void {
    if (this.editorSelectionDebounceTimer != null) {
      clearTimeout(this.editorSelectionDebounceTimer);
      this.editorSelectionDebounceTimer = null;
    }
    this.editorSelectionDisposable?.dispose();
    this.editorSelectionDisposable = null;
  }

  private wireEditorSelectionListener(): void {
    this.disposeEditorSelectionListener();
    const ed = this.editor;
    if (!ed) {
      return;
    }
    this.editorSelectionDisposable = ed.onDidChangeCursorSelection(() => {
      if (this.editorSelectionDebounceTimer != null) {
        clearTimeout(this.editorSelectionDebounceTimer);
      }
      this.editorSelectionDebounceTimer = setTimeout(() => {
        this.editorSelectionDebounceTimer = null;
        this.emitEditorSelectionFromActiveEditor();
      }, EDITOR_SELECTION_DEBOUNCE_MS);
    });
  }

  private emitEditorSelectionFromActiveEditor(): void {
    if (!this.focused()) {
      return;
    }
    const ed = this.editor;
    if (!ed || this.monacoDiffActive()) {
      this.zone.run(() => this.emitOutput(this.editorSelectionChange, null));
      return;
    }
    const model = ed.getModel();
    if (!model) {
      this.zone.run(() => this.emitOutput(this.editorSelectionChange, null));
      return;
    }
    const modelKey = this.store.modelKeyForModel(model);
    const rel = modelKey ? relativePathFromModelKey(modelKey) : null;
    if (!rel?.trim()) {
      this.zone.run(() => this.emitOutput(this.editorSelectionChange, null));
      return;
    }
    const selection = ed.getSelection();
    if (!selection || selection.isEmpty()) {
      this.zone.run(() => this.emitOutput(this.editorSelectionChange, null));
      return;
    }
    if (!modelKey || isExternalModelKey(modelKey)) {
      this.zone.run(() => this.emitOutput(this.editorSelectionChange, null));
      return;
    }
    const relNorm = normalizePathSlashes(rel.trim());
    const absFromRef = this.store.fileRefForKey(modelKey)?.absolutePath?.trim();
    const root = this.workspacePath().trim();
    const abs =
      absFromRef ||
      (root ? `${normalizePathSlashes(root).replace(/\/+$/, '')}/${relNorm}` : '');
    if (!abs) {
      this.zone.run(() => this.emitOutput(this.editorSelectionChange, null));
      return;
    }
    const name = relNorm.split('/').filter(Boolean).pop() ?? relNorm;
    const lineRange = {
      startLine: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLine: selection.endLineNumber,
      endColumn: selection.endColumn,
    };
    const payload: EditorSelectionPayload = {
      absolutePath: abs,
      relativePath: relNorm,
      name,
      lineRange,
      selectedText: model.getValueInRange(selection),
    };
    this.zone.run(() => this.emitOutput(this.editorSelectionChange, payload));
  }

  private disposeDiffSurface(): void {
    this.diffEditor?.dispose();
    void import('../../../../monaco-hover-delegate-safety').then((m) => m.ensureMonacoHoverDelegateSafe());
    this.diffEditor = null;
    if (this.diffOriginalModel && !this.diffOriginalModel.isDisposed()) {
      this.diffOriginalModel.dispose();
    }
    this.diffOriginalModel = null;
    if (this.diffModifiedModel && !this.diffModifiedModel.isDisposed()) {
      this.diffModifiedModel.dispose();
    }
    this.diffModifiedModel = null;
    this.diffMountedKey = '';
  }

  private mountOrUpdateDiffEditor(diff: WorkspaceMonacoReadOnlyDiff): void {
    const monacoApi = this.monaco;
    if (!monacoApi) {
      return;
    }
    const displayPath = diff.relativePath;
    const lang = monacoLanguageIdForPath(monacoApi, displayPath);
    const { settings } = normalizeMonacoWorkspaceEditorSettings(this.editorSettings() == null ? undefined : this.editorSettings()!);
    const mapped = monacoWorkspaceSettingsToEditorOptions(settings);

    const host = this.diffHost().nativeElement;

    if (!this.diffEditor || this.diffMountedKey !== diff.modelKey) {
      this.disposeDiffSurface();
      this.diffMountedKey = diff.modelKey;
      this.diffEditor = monacoApi.editor.createDiffEditor(host, {
        ...mapped,
        theme: this.monacoThemeName(settings),
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
      });
      void import('../../../../monaco-hover-delegate-safety').then((m) => m.ensureMonacoHoverDelegateSafe());
      monacoApi.editor.setTheme(this.monacoThemeName(settings));

      // Diff models are per-instance: suffix the URI with the owner id so two slots showing
      // the same turn diff never collide on `createModel`.
      const uriPath = encodeURI(`${diff.modelKey}/${displayPath}`);
      this.diffOriginalModel = monacoApi.editor.createModel(
        diff.original,
        lang,
        monacoApi.Uri.parse(`clara-diff-org://${this.ownerId}/${uriPath}`),
      );
      this.diffModifiedModel = monacoApi.editor.createModel(
        diff.modified,
        lang,
        monacoApi.Uri.parse(`clara-diff-mod://${this.ownerId}/${uriPath}`),
      );
      this.diffEditor.setModel({
        original: this.diffOriginalModel,
        modified: this.diffModifiedModel,
      });
    } else {
      if (this.diffOriginalModel && !this.diffOriginalModel.isDisposed() && this.diffOriginalModel.getValue() !== diff.original) {
        this.diffOriginalModel.setValue(diff.original);
      }
      if (this.diffModifiedModel && !this.diffModifiedModel.isDisposed() && this.diffModifiedModel.getValue() !== diff.modified) {
        this.diffModifiedModel.setValue(diff.modified);
      }
    }

    this.diffEditor.layout();
    this.loadError.set('');
    this.detachedBanner.set('');
  }

  /** Loads or creates the shared text model for {@param modelKey}; surfaces load errors in this slot. */
  private async getOrCreateModel(modelKey: string): Promise<Monaco.editor.ITextModel | null> {
    const res = await this.store.getOrCreateModel(modelKey);
    if (!res.model) {
      if (res.error) {
        this.loadError.set(res.error);
      }
      return null;
    }
    this.loadError.set('');
    return res.model;
  }

  private async syncActiveModel(modelKey: string): Promise<void> {
    const monacoApi = this.monaco;
    const ed = this.editor;
    if (!monacoApi || !ed) {
      return;
    }
    const currentModel = ed.getModel();
    if (currentModel) {
      const currentRel = this.store.workspaceRelativePathForModel(currentModel);
      const nextRel = relativePathFromModelKey(modelKey);
      if (
        currentRel &&
        nextRel &&
        normalizePathSlashes(currentRel) !== normalizePathSlashes(nextRel)
      ) {
        this.captureEditorViewStateForPath(normalizePathSlashes(currentRel));
      }
    }
    const model = await this.getOrCreateModel(modelKey);
    if (!model || this.destroyed) {
      return;
    }
    // Active key changed while loading; the newer sync will attach its own model.
    if (this.activeModelKey()?.trim() !== modelKey) {
      return;
    }
    if (this.store.isDetachedKey(modelKey)) {
      this.updateDetachedBanner(modelKey);
    } else {
      this.detachedBanner.set('');
    }
    this.loadError.set('');
    // Avoid redundant setModel — each model swap notifies FindController and can
    // race Monaco's FindWidget constructor (searchScope toggle not yet created).
    if (ed.getModel() !== model) {
      ed.setModel(model);
    }
    ed.updateOptions({
      'semanticHighlighting.enabled': true,
    } as Monaco.editor.IEditorOptions & { 'semanticHighlighting.enabled'?: boolean });
    void this.store.prefetchSemanticLegendForModel(model);
    const forcePreview = this.isForcePreviewKey(modelKey);
    const mdMode = forcePreview ? 'preview' : (this.mdViewModeByPath.get(modelKey) ?? 'edit');
    if (forcePreview) {
      this.mdViewModeByPath.set(modelKey, 'preview');
    }
    const displayPath = displayPathForModelKey(modelKey);
    if (displayPath.toLowerCase().endsWith('.md') && mdMode === 'preview') {
      this.enterMdPreview(modelKey);
    } else {
      this.exitMdPreview(false);
      requestAnimationFrame(() => {
        const rel = relativePathFromModelKey(modelKey);
        if (rel) {
          this.restoreEditorViewStateForPath(normalizePathSlashes(rel));
        }
        if (this.focused()) {
          ed.focus();
        }
      });
    }
  }

  private captureEditorViewStateForPath(relativeKey: string, workspaceIdOverride?: string): void {
    const ed = this.editor;
    if (!ed || this.monacoDiffActive() || this.mdPreviewActive()) {
      return;
    }
    const model = ed.getModel();
    if (!model) {
      return;
    }
    const modelRel = this.store.workspaceRelativePathForModel(model);
    if (!modelRel || normalizePathSlashes(modelRel) !== normalizePathSlashes(relativeKey)) {
      return;
    }
    const state = ed.saveViewState();
    if (!state) {
      return;
    }
    this.viewStateByPath.set(relativeKey, state);
    this.schedulePersistScroll(
      relativeKey,
      ed.getScrollTop(),
      ed.getScrollLeft(),
      workspaceIdOverride,
    );
  }

  private restoreEditorViewStateForPath(relativeKey: string): void {
    const ed = this.editor;
    if (!ed || this.monacoDiffActive() || this.mdPreviewActive()) {
      return;
    }
    const state = this.viewStateByPath.get(relativeKey);
    if (state) {
      ed.restoreViewState(state);
      return;
    }
    const persisted = this.persistedScrollByPath()[relativeKey];
    if (persisted) {
      ed.setScrollTop(persisted.scrollTop);
      ed.setScrollLeft(persisted.scrollLeft);
    }
  }

  private onEditorScrollChanged(): void {
    const ed = this.editor;
    if (!ed || this.monacoDiffActive() || this.mdPreviewActive()) {
      return;
    }
    const model = ed.getModel();
    if (!model) {
      return;
    }
    const key = this.store.workspaceRelativePathForModel(model);
    if (!key) {
      return;
    }
    const state = ed.saveViewState();
    if (!state) {
      return;
    }
    this.viewStateByPath.set(key, state);
    this.schedulePersistScroll(key, ed.getScrollTop(), ed.getScrollLeft());
  }

  private schedulePersistScroll(
    relativeKey: string,
    scrollTop: number,
    scrollLeft: number,
    workspaceIdOverride?: string,
  ): void {
    const wsId = (workspaceIdOverride ?? this.workspaceId()?.trim()) || '';
    if (!wsId || !this.electron.isElectron) {
      return;
    }
    this.pendingScrollPersist = { workspaceId: wsId, key: relativeKey, scrollTop, scrollLeft };
    if (this.scrollPersistTimer != null) {
      clearTimeout(this.scrollPersistTimer);
    }
    this.scrollPersistTimer = window.setTimeout(() => {
      this.scrollPersistTimer = null;
      void this.flushPendingScrollPersist();
    }, 400);
  }

  private async flushPendingScrollPersist(forceWorkspaceId?: string): Promise<void> {
    if (this.scrollPersistTimer != null) {
      clearTimeout(this.scrollPersistTimer);
      this.scrollPersistTimer = null;
    }
    const pending = this.pendingScrollPersist;
    if (!pending || !this.electron.isElectron) {
      return;
    }
    if (forceWorkspaceId && pending.workspaceId !== forceWorkspaceId) {
      return;
    }
    this.pendingScrollPersist = null;
    await this.electron.patchWorkspaceMonacoScroll(pending.workspaceId, pending.key, {
      scrollTop: pending.scrollTop,
      scrollLeft: pending.scrollLeft,
    });
  }

  private async saveCurrent(): Promise<void> {
    const ed = this.editor;
    const modelKey = this.activeModelKey()?.trim();
    if (!ed || !modelKey) {
      return;
    }
    const model = ed.getModel();
    if (!model || this.store.getModel(modelKey) !== model) {
      return;
    }
    const { settings } = normalizeMonacoWorkspaceEditorSettings(this.editorSettings() ?? undefined);
    if (settings.formatOnSave && model.uri.scheme === 'clara-workspace' && !this.store.isDetachedKey(modelKey)) {
      await ed.getAction('editor.action.formatDocument')?.run();
    }
    const res = await this.store.saveKey(modelKey);
    if (!res.ok) {
      if (res.error) {
        this.loadError.set(res.error);
      }
      return;
    }
    this.loadError.set('');
    this.detachedBanner.set('');
  }
}
