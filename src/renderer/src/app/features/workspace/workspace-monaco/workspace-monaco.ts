import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
  LSP_MONACO_LANGUAGE_IDS,
  lspServerIdForMonacoLanguageId,
  lspServerKindForWorkspaceRelativePath,
  type FileDiffPayload,
  type MonacoWorkspaceEditorSettings,
  type StagedTransferBatchPayload,
  type StagedTransferFileResolution,
  type WorkspaceFilesChangedMessage,
} from '@shared/index';
import { normalizeMonacoWorkspaceEditorSettings } from '@shared/index';
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
import { PendingDiffReviewService, type BatchFinishFn, type BatchPartialFn } from '../../diff/pending-diff-review.service';
import { mergedContentForDiffPreview } from '../../diff/diff-rebuild';
import { monacoWorkspaceSettingsToEditorOptions } from './workspace-monaco-editor-options';
import { renderMarkdownDoc } from './markdown-doc-renderer';
import type { EditorSelectionPayload } from '../../chat/chat-context-bar/chat-context-file';
import { registerWorkspaceMonacoLsp } from './workspace-monaco-lsp';
import { markMonacoModelLspDocumentSynced, monacoModelNeedsLspDocumentSync } from './workspace-monaco-lsp-sync-state';

const EDITOR_SELECTION_DEBOUNCE_MS = 50;

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

@Component({
  selector: 'app-workspace-monaco',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  private readonly pendingDiffReview = inject(PendingDiffReviewService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly inj = inject(Injector);

  /** Absolute workspace root (empty when none). */
  readonly workspacePath = input<string>('');
  /** Active editor model key (`rel:…` or `abs:…`), or null when no file tab is selected. */
  readonly activeModelKey = input<string | null>(null);
  /** Open file tabs Monaco should keep models for. */
  readonly openEditorFiles = input<readonly OpenEditorFileRef[]>([]);
  /** Persisted Monaco options from app config (optional until loaded). */
  readonly editorSettings = input<MonacoWorkspaceEditorSettings | null | undefined>(undefined);
  /** Pending diff for this path from the shell (same artifact as chat review). */
  readonly pendingDiffPayload = input<FileDiffPayload | null>(null);
  /** When the active file is part of a pending staged-transfer batch, the batch payload. */
  readonly pendingStagedTransferBatch = input<StagedTransferBatchPayload | null>(null);
  readonly conversationId = input<string | null>(null);
  /** After cross-file go-to-definition: reveal cursor once this path is the active editor model. */
  readonly pendingEditorReveal = input<{ relativePath: string; line: number; column: number } | null>(null);
  /** Model keys that should open in markdown preview and hide the edit/preview toggle. */
  readonly forcePreviewForKeys = input<ReadonlySet<string> | readonly string[]>([]);
  /** Live build-plan markdown while the planner streams (full content replacement). */
  readonly buildPlanLiveContent = input<{ relativePath: string; content: string } | null>(null);
  /** Model keys receiving live build-plan chunks — skip disk reload while streaming. */
  readonly buildPlanStreamingKeys = input<ReadonlySet<string> | readonly string[]>([]);

  private readonly buildPlanStreamingKeySet = computed(() => {
    const raw = this.buildPlanStreamingKeys();
    if (raw instanceof Set) {
      return raw;
    }
    return new Set(raw);
  });
  readonly unsavedPathsChange = output<readonly string[]>();
  readonly detachedPathsChange = output<readonly string[]>();
  readonly outsideWorkspacePathsChange = output<readonly string[]>();
  readonly saveAsCompleted = output<{
    oldModelKey: string;
    relativePath?: string;
    absolutePath?: string;
    outsideWorkspace: boolean;
  }>();
  readonly diffReviewFinished = output<{
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }>();
  readonly stagedTransferBatchFinished = output<{
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
    fileResolutions: Record<string, StagedTransferFileResolution>;
  }>();
  readonly stagedTransferBatchFileResolved = output<{
    requestId: string;
    fileResolutions: Record<string, StagedTransferFileResolution>;
  }>();
  /** Cross-file definition navigation (shell opens/focuses tab; optional reveal via {@link pendingEditorReveal}). */
  readonly navigateWorkspaceFile = output<{ relativePath: string; line: number; column: number }>();
  readonly pendingEditorRevealHandled = output<void>();
  /** Non-empty editor text selection in a workspace file (null when cleared or unavailable). */
  readonly editorSelectionChange = output<EditorSelectionPayload | null>();

  protected readonly loadError = signal('');
  protected readonly detachedBanner = signal('');
  protected readonly applyMessage = signal('');
  /** Notes when returning a staged transfer for re-review (matches chat diff card). */
  protected readonly reReviewFeedback = signal('');
  /** Block inline diff until the buffer matches disk (policy: save or revert first). */
  protected readonly pendingDiffBlockedByDirty = computed(() => {
    const pending = this.pendingDiffPayload();
    const rel = relativePathFromModelKey(this.activeModelKey()?.trim() ?? '');
    if (!pending || !rel?.trim()) {
      return false;
    }
    if (normalizePathSlashes(pending.relativePath) !== normalizePathSlashes(rel)) {
      return false;
    }
    const key = editorModelKeyForRelativePath(rel);
    const model = this.modelByPath.get(key);
    const synced = this.diskSyncedAltVersionByPath.get(key);
    return !!(model && synced !== undefined && model.getAlternativeVersionId() !== synced);
  });

  protected readonly monacoDiffActive = computed(() => {
    const pending = this.pendingDiffPayload();
    const rel = relativePathFromModelKey(this.activeModelKey()?.trim() ?? '');
    if (!pending || !rel?.trim()) {
      return false;
    }
    if (normalizePathSlashes(pending.relativePath) !== normalizePathSlashes(rel)) {
      return false;
    }
    return !this.pendingDiffBlockedByDirty();
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
    if (!key) {
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

  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private editorSelectionDisposable: Monaco.IDisposable | null = null;
  private editorSelectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private diffOriginalModel: Monaco.editor.ITextModel | null = null;
  private diffModifiedModel: Monaco.editor.ITextModel | null = null;
  /** Matches {@link PendingDiffReviewService.sessionKey} for the mounted diff surface. */
  private diffMountedPayloadKey = '';

  private readonly editorReady = signal(false);
  private uiThemeObserver: MutationObserver | null = null;
  private themeRefreshRaf: number | null = null;
  private readonly modelByPath = new Map<string, Monaco.editor.ITextModel>();
  /** Shared with ``registerWorkspaceMonacoLsp`` — updated when TS/JS semantic legend is prefetched. */
  private readonly semanticLegendsByServer: Record<string, Monaco.languages.SemanticTokensLegend> = {};
  private readonly tsSemanticLegendPrefetchedKeys = new Set<string>();
  private readonly diskSyncedAltVersionByPath = new Map<string, number>();
  private readonly modelDirtyDisposables = new Map<string, Monaco.IDisposable>();
  private readonly fileRefByKey = new Map<string, OpenEditorFileRef>();
  private readonly detachedByKey = new Map<
    string,
    { tempAbsolutePath: string; snapshotAltVersionId: number; defaultRelativePath: string }
  >();
  private lspHoverDisposables: Monaco.IDisposable[] = [];
  private lspLanguageDisposable: Monaco.IDisposable | null = null;

  constructor() {
    afterNextRender(() => void this.bootstrapEditor());

    effect(() => {
      const open = this.openEditorFiles().map((f) => f.modelKey);
      const refs = this.openEditorFiles();
      if (!this.monaco) {
        return;
      }
      untracked(() => {
        for (const ref of refs) {
          this.fileRefByKey.set(ref.modelKey, ref);
        }
        for (const [key, model] of this.modelByPath) {
          if (!open.includes(key)) {
            if (this.editor?.getModel() === model) {
              this.editor.setModel(null);
            }
            this.modelDirtyDisposables.get(key)?.dispose();
            this.modelDirtyDisposables.delete(key);
            model.dispose();
            this.modelByPath.delete(key);
            this.diskSyncedAltVersionByPath.delete(key);
            void this.cleanupDetachedSnapshot(key);
            this.detachedByKey.delete(key);
            this.fileRefByKey.delete(key);
          }
        }
        this.emitDetachedPaths();
        this.emitOutsideWorkspacePaths();
        this.emitDirtyPaths();
      });
    });

    effect(() => {
      const key = this.activeModelKey()?.trim();
      const root = this.workspacePath()?.trim();
      const ready = this.editorReady();
      const diffOn = this.monacoDiffActive();
      const pending = this.pendingDiffPayload();
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
      const rel = relativePathFromModelKey(key);
      if (diffOn && pending && rel) {
        const s = this.pendingDiffReview.sessionFor(pending);
        s.accepted();
        s.skipped();
        untracked(() => void this.mountOrUpdateDiffEditor(root, key, pending));
      } else {
        untracked(() => {
          this.disposeDiffSurface();
          void this.syncActiveModel(root, key);
        });
      }
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
        if (settings.theme === 'clara-monaco') {
          this.defineClaraTheme(monacoApi);
        }
        monacoApi.editor.setTheme(settings.theme);
      });
    });

    // Diff review wins over markdown preview: entering review force-exits preview
    // and resets the remembered mode so the review surface is never obscured.
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
      untracked(() => {
        const model = this.modelByPath.get(key);
        if (!model || model.isDisposed()) {
          return;
        }
        if (model.getValue() !== live.content) {
          model.setValue(live.content);
          this.diskSyncedAltVersionByPath.set(key, model.getAlternativeVersionId());
          this.emitDirtyPaths();
        }
      });
    });

    this.electron.workspaceFilesChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.onWorkspaceFilesChanged(event));

    if (typeof MutationObserver !== 'undefined') {
      this.uiThemeObserver = new MutationObserver(() => this.scheduleMonacoRefreshAfterUiThemeChange());
      this.uiThemeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-bs-theme'],
      });
    }

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
          this.zone.run(() => this.pendingEditorRevealHandled.emit());
        });
      });
    });

    this.destroyRef.onDestroy(() => {
      this.mdPreviewContentDisposable?.dispose();
      this.mdPreviewContentDisposable = null;
      if (this.mdPreviewRenderTimer != null) {
        clearTimeout(this.mdPreviewRenderTimer);
        this.mdPreviewRenderTimer = null;
      }
      for (const d of this.lspHoverDisposables) {
        d.dispose();
      }
      this.lspHoverDisposables = [];
      this.lspLanguageDisposable?.dispose();
      this.lspLanguageDisposable = null;
      if (this.themeRefreshRaf != null) {
        cancelAnimationFrame(this.themeRefreshRaf);
        this.themeRefreshRaf = null;
      }
      this.uiThemeObserver?.disconnect();
      this.uiThemeObserver = null;
      this.disposeDiffSurface();
      for (const m of this.modelByPath.values()) {
        m.dispose();
      }
      this.modelByPath.clear();
      this.diskSyncedAltVersionByPath.clear();
      this.detachedByKey.clear();
      this.fileRefByKey.clear();
      this.disposeEditorSelectionListener();
      this.editor?.dispose();
      this.editor = null;
      this.monaco = null;
    });
  }

  private readonly finishEmit = (e: {
    relativePath: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }): void => {
    this.diffReviewFinished.emit(e);
  };

  private readonly batchFinishEmit: BatchFinishFn = (e) => {
    this.stagedTransferBatchFinished.emit(e);
  };

  private readonly batchPartialEmit: BatchPartialFn = (e) => {
    this.stagedTransferBatchFileResolved.emit(e);
  };

  private async resolveBatchStagedTransfer(
    action: 'confirm' | 're_review',
    feedback: string,
  ): Promise<void> {
    const batch = this.pendingStagedTransferBatch();
    const file = this.pendingDiffPayload();
    if (!batch || !file || !this.isBatchStagedTransfer()) {
      return;
    }
    await this.pendingDiffReview.resolveStagedTransferBatchFile(
      batch,
      file.relativePath,
      action,
      feedback,
      this.conversationId(),
      (msg, ms) => this.flashApplyMessage(msg, ms),
      this.batchFinishEmit,
      this.batchPartialEmit,
    );
  }

  private flashApplyMessage(msg: string, ms: number): void {
    this.applyMessage.set(msg);
    setTimeout(() => this.applyMessage.set(''), ms);
  }

  protected async onAcceptCurrentChange(): Promise<void> {
    const p = this.pendingDiffPayload();
    if (!p) return;
    await this.pendingDiffReview.acceptCurrentChange(
      p,
      this.conversationId(),
      (msg, ms) => this.flashApplyMessage(msg, ms),
      this.finishEmit,
    );
  }

  protected async onSkipCurrentChange(): Promise<void> {
    const p = this.pendingDiffPayload();
    if (!p) return;
    await this.pendingDiffReview.skipCurrentChange(
      p,
      this.conversationId(),
      (msg, ms) => this.flashApplyMessage(msg, ms),
      this.finishEmit,
    );
  }

  protected async onApplyAllAtOnce(): Promise<void> {
    const p = this.pendingDiffPayload();
    if (!p) return;
    await this.pendingDiffReview.applyAllAtOnce(
      p,
      this.conversationId(),
      (msg, ms) => this.flashApplyMessage(msg, ms),
      this.finishEmit,
    );
  }

  protected async onCancelProposal(): Promise<void> {
    const p = this.pendingDiffPayload();
    if (!p) return;
    if (this.isBatchStagedTransfer()) {
      await this.resolveBatchStagedTransfer(
        're_review',
        '(user dismissed the transfer review without approving)',
      );
      return;
    }
    await this.pendingDiffReview.cancelProposal(
      p,
      this.conversationId(),
      (msg, ms) => this.flashApplyMessage(msg, ms),
      this.finishEmit,
    );
  }

  protected async onApproveStagedTransfer(): Promise<void> {
    const p = this.pendingDiffPayload();
    if (!p) return;
    if (this.isBatchStagedTransfer()) {
      await this.resolveBatchStagedTransfer('confirm', '');
      return;
    }
    await this.pendingDiffReview.approveStagedTransferHitl(
      p,
      this.conversationId(),
      (msg, ms) => this.flashApplyMessage(msg, ms),
      this.finishEmit,
    );
  }

  protected async onReturnStagedForReReview(): Promise<void> {
    const p = this.pendingDiffPayload();
    if (!p) return;
    if (this.isBatchStagedTransfer()) {
      await this.resolveBatchStagedTransfer('re_review', this.reReviewFeedback());
      this.reReviewFeedback.set('');
      return;
    }
    await this.pendingDiffReview.returnStagedTransferForReReview(
      p,
      this.conversationId(),
      this.reReviewFeedback(),
      (msg, ms) => this.flashApplyMessage(msg, ms),
      this.finishEmit,
    );
  }

  @HostListener('keydown', ['$event'])
  protected onKeydown(ev: KeyboardEvent): void {
    // Monaco's own Ctrl+S binding only fires while the (hidden) editor has focus.
    if (this.mdPreviewActive() && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void this.saveCurrent();
      return;
    }
    if (!this.monacoDiffActive()) {
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      void this.onAcceptCurrentChange();
    }
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
    const model = this.modelByPath.get(key);
    if (!model || model.isDisposed()) {
      // The activePreviewOnly effect can fire before syncActiveModel finishes creating the
      // model (modelByPath is a plain Map, not reactive). Retry a few frames so the preview
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
    // reloading the model via workspaceFilesChanged$ → reloadModelFromDiskIfUnmodified.
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
    const model = this.modelByPath.get(key);
    const root = this.workspacePath()?.trim();
    if (!model || model.isDisposed() || !root) {
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

  protected readonly applying = computed(() => {
    const p = this.pendingDiffPayload();
    if (!p) return false;
    return this.pendingDiffReview.sessionFor(p).applying();
  });

  protected readonly incrementalOk = computed(() => {
    const p = this.pendingDiffPayload();
    if (!p) return false;
    return this.pendingDiffReview.incrementalOk(p);
  });

  protected readonly isStagedTransferHitl = computed(() => !!this.pendingDiffPayload()?.stagedTransferHitl);

  /** True when the pending diff is one file inside an active staged-transfer batch. */
  protected readonly isBatchStagedTransfer = computed(() => {
    const batch = this.pendingStagedTransferBatch();
    const file = this.pendingDiffPayload();
    if (!batch || !file?.stagedTransferHitl) {
      return false;
    }
    const norm = normalizePathSlashes(file.relativePath);
    return batch.files.some((f) => normalizePathSlashes(f.relativePath) === norm);
  });

  protected readonly changeHunkOrder = computed(() => {
    const p = this.pendingDiffPayload();
    if (!p) return [] as number[];
    return this.pendingDiffReview.changeHunkOrder(p);
  });

  protected readonly changeProgressLabel = computed(() => {
    const p = this.pendingDiffPayload();
    if (!p) return '';
    const order = this.pendingDiffReview.changeHunkOrder(p);
    if (order.length === 0) return '';
    const s = this.pendingDiffReview.sessionFor(p);
    const acc = s.accepted();
    const sk = s.skipped();
    const done = order.filter((h) => acc.has(h) || sk.has(h)).length;
    const next = order.find((h) => !acc.has(h) && !sk.has(h));
    if (next == null) {
      return `${done} / ${order.length} changes (done)`;
    }
    const at = order.indexOf(next) + 1;
    return `Change ${at} of ${order.length} (${done} resolved)`;
  });

  private scheduleMonacoRefreshAfterUiThemeChange(): void {
    if (this.themeRefreshRaf != null) {
      cancelAnimationFrame(this.themeRefreshRaf);
    }
    this.themeRefreshRaf = requestAnimationFrame(() => {
      this.themeRefreshRaf = null;
      this.refreshMonacoAfterUiThemeChange();
      requestAnimationFrame(() => {
        this.editor?.layout();
        this.diffEditor?.layout();
      });
    });
  }

  private refreshMonacoAfterUiThemeChange(): void {
    const ed = this.editor;
    const monacoApi = this.monaco;
    if (!this.editorReady() || !ed || !monacoApi) {
      return;
    }
    const cfg = this.editorSettings();
    const { settings } = normalizeMonacoWorkspaceEditorSettings(cfg == null ? undefined : cfg);
    const mapped = monacoWorkspaceSettingsToEditorOptions(settings);
    ed.updateOptions(mapped);
    if (this.diffEditor) {
      const { theme: _t, ...diffOpts } = mapped as Record<string, unknown>;
      this.diffEditor.updateOptions(diffOpts as Monaco.editor.IDiffEditorConstructionOptions);
    }
    if (settings.theme === 'clara-monaco') {
      this.defineClaraTheme(monacoApi);
    }
    monacoApi.editor.setTheme(settings.theme);
    ed.layout();
    this.diffEditor?.layout();
  }

  private workspaceRootsEqual(a: string, b: string): boolean {
    const x = normalizePathSlashes(a).replace(/\/+$/, '').toLowerCase();
    const y = normalizePathSlashes(b).replace(/\/+$/, '').toLowerCase();
    return x.length > 0 && x === y;
  }

  private onWorkspaceFilesChanged(event: WorkspaceFilesChangedMessage): void {
    const root = this.workspacePath()?.trim();
    if (!root || !this.workspaceRootsEqual(root, event.workspacePath)) {
      return;
    }

    const refreshAll = event.paths.some((p) => {
      const s = normalizePathSlashes(p.trim());
      return s === '.' || s === '';
    });

    const keys = new Set<string>();
    if (refreshAll) {
      for (const k of this.modelByPath.keys()) {
        keys.add(k);
      }
    } else {
      for (const p of event.paths) {
        if (p.startsWith('[staging] ')) {
          continue;
        }
        const relKey = editorModelKeyForRelativePath(normalizePathSlashes(p));
        if (this.modelByPath.has(relKey)) {
          keys.add(relKey);
        }
      }
      for (const k of this.modelByPath.keys()) {
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

  private async ensureWorkspaceLink(modelKey: string): Promise<void> {
    if (isExternalModelKey(modelKey) || this.detachedByKey.has(modelKey)) {
      return;
    }
    const rel = relativePathFromModelKey(modelKey);
    const root = this.workspacePath()?.trim();
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

  private async detachModel(modelKey: string, defaultRelativePath: string): Promise<void> {
    if (this.detachedByKey.has(modelKey)) {
      return;
    }
    const model = this.modelByPath.get(modelKey);
    if (!model || model.isDisposed()) {
      return;
    }
    const snap = await this.electron.writeEditorDetachedSnapshot(model.getValue());
    if (!snap.ok || !snap.path) {
      this.loadError.set(snap.error ?? 'Failed to snapshot detached file.');
      return;
    }
    const alt = model.getAlternativeVersionId();
    this.detachedByKey.set(modelKey, {
      tempAbsolutePath: snap.path,
      snapshotAltVersionId: alt,
      defaultRelativePath,
    });
    this.emitDetachedPaths();
    this.updateDetachedBanner(modelKey);
    this.emitDirtyPaths();
  }

  private updateDetachedBanner(modelKey: string): void {
    if (this.activeModelKey()?.trim() === modelKey) {
      this.detachedBanner.set('This file no longer exists at this path. Save to choose a location.');
      this.loadError.set('');
    }
  }

  private async cleanupDetachedSnapshot(modelKey: string): Promise<void> {
    const d = this.detachedByKey.get(modelKey);
    if (!d) {
      return;
    }
    await this.electron.deleteEditorDetachedSnapshot(d.tempAbsolutePath);
  }

  private emitDetachedPaths(): void {
    const list = [...this.detachedByKey.keys()].sort();
    this.zone.run(() => this.detachedPathsChange.emit(list));
  }

  private emitOutsideWorkspacePaths(): void {
    const list = [...this.fileRefByKey.entries()]
      .filter(([, ref]) => ref.outsideWorkspace)
      .map(([k]) => k)
      .sort();
    this.zone.run(() => this.outsideWorkspacePathsChange.emit(list));
  }

  /** Shell: close tab after discard — remove temp snapshot for a detached key. */
  async cleanupDetachedForKey(modelKey: string): Promise<void> {
    await this.cleanupDetachedSnapshot(modelKey);
    this.detachedByKey.delete(modelKey);
    this.emitDetachedPaths();
    if (this.activeModelKey()?.trim() === modelKey) {
      this.detachedBanner.set('');
    }
  }

  isDetachedKey(modelKey: string): boolean {
    return this.detachedByKey.has(modelKey);
  }

  /** Shell: Save As for detached/dirty tab; returns new model key when saved. */
  async saveAsForKey(modelKey: string): Promise<string | null> {
    return this.promptSaveAs(modelKey);
  }

  private retargetModelKey(fromKey: string, toKey: string): void {
    if (fromKey === toKey) {
      return;
    }
    const model = this.modelByPath.get(fromKey);
    if (!model || model.isDisposed()) {
      return;
    }
    this.modelByPath.delete(fromKey);
    this.modelByPath.set(toKey, model);
    const synced = this.diskSyncedAltVersionByPath.get(fromKey);
    if (synced !== undefined) {
      this.diskSyncedAltVersionByPath.set(toKey, synced);
      this.diskSyncedAltVersionByPath.delete(fromKey);
    }
    const dirty = this.modelDirtyDisposables.get(fromKey);
    if (dirty) {
      dirty.dispose();
      this.modelDirtyDisposables.delete(fromKey);
      this.ensureModelDirtyListener(toKey, model);
    }
    const mdMode = this.mdViewModeByPath.get(fromKey);
    if (mdMode) {
      this.mdViewModeByPath.set(toKey, mdMode);
      this.mdViewModeByPath.delete(fromKey);
    }
    void this.cleanupDetachedSnapshot(fromKey);
    this.detachedByKey.delete(fromKey);
    const ref = this.fileRefByKey.get(fromKey);
    if (ref) {
      this.fileRefByKey.delete(fromKey);
      const rel = relativePathFromModelKey(toKey);
      this.fileRefByKey.set(toKey, {
        ...ref,
        modelKey: toKey,
        relativePath: rel ?? ref.relativePath,
        absolutePath: undefined,
        outsideWorkspace: false,
      });
    }
    this.emitDetachedPaths();
    this.emitOutsideWorkspacePaths();
    this.emitDirtyPaths();
  }

  private async reloadModelFromDiskIfUnmodified(modelKey: string): Promise<void> {
    if (this.buildPlanStreamingKeySet().has(modelKey)) {
      return;
    }
    const monacoApi = this.monaco;
    const root = this.workspacePath()?.trim();
    const model = this.modelByPath.get(modelKey);
    if (!monacoApi || !root || !model || model.isDisposed()) {
      return;
    }
    if (isExternalModelKey(modelKey) || this.detachedByKey.has(modelKey)) {
      return;
    }
    const rel = relativePathFromModelKey(modelKey);
    if (!rel) {
      return;
    }

    let baseline = this.diskSyncedAltVersionByPath.get(modelKey);
    if (baseline === undefined) {
      baseline = model.getAlternativeVersionId();
      this.diskSyncedAltVersionByPath.set(modelKey, baseline);
    }
    if (model.getAlternativeVersionId() !== baseline) {
      return;
    }

    const res = await this.electron.readWorkspaceFile(root, rel);
    const activeKey = this.activeModelKey()?.trim() ?? '';

    if (!res.ok || res.content === undefined) {
      await this.detachModel(modelKey, rel);
      return;
    }

    if (modelKey === activeKey) {
      this.loadError.set('');
      this.detachedBanner.set('');
    }
    if (model.getValue() !== res.content) {
      model.setValue(res.content);
    }
    this.diskSyncedAltVersionByPath.set(modelKey, model.getAlternativeVersionId());
    this.emitDirtyPaths();
  }

  private languageIdForPath(monacoApi: typeof Monaco, rel: string): string {
    const base = rel.split('/').pop() ?? rel;
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

  /**
   * Monaco resolves semantic token styles via {@link StandaloneTheme.getTokenStyleMetadata}
   * → {@link TokenTheme._match} on the selector ``${type}.${modifier.join('.')}``.
   * Standalone Monaco does **not** apply {@link IStandaloneThemeData.semanticTokenColors}; only
   * {@link IStandaloneThemeData.rules} participates in that trie (see monaco-editor#1833).
   */
  private claraSemanticTokenRules(): Monaco.editor.ITokenThemeRule[] {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const hex = (css: string, fb: string) => {
      const raw = (css.trim() || fb).trim();
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
        return raw.slice(1);
      }
      if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
        const r = raw[1];
        const g = raw[2];
        const b = raw[3];
        return `${r}${r}${g}${g}${b}${b}`;
      }
      return fb.replace(/^#/, '');
    };
    const fg = hex(pick('--t-code-text', '#d4d4d4'), 'd4d4d4');
    const accent = hex(pick('--t-primary', '#00ff41'), '00ff41');
    const typeTone = hex(pick('--t-code-type', '#4EC9B0'), '4EC9B0');
    const paramTone = hex(pick('--t-code-param', '#9CDCFE'), '9CDCFE');
    const enumTone = hex(pick('--t-code-enum', '#4FC1FF'), '4FC1FF');
    const kw = hex(pick('--t-code-keyword', '#569CD6'), '569CD6');
    const str = hex(pick('--t-code-string', '#CE9178'), 'CE9178');
    const num = hex(pick('--t-code-number', '#B5CEA8'), 'B5CEA8');
    const mut = hex(pick('--t-text-muted', '#808080'), '808080');
    const rules: Monaco.editor.ITokenThemeRule[] = [
      { token: 'namespace', foreground: typeTone },
      { token: 'type', foreground: typeTone },
      { token: 'class', foreground: typeTone },
      { token: 'enum', foreground: typeTone },
      { token: 'interface', foreground: typeTone },
      { token: 'struct', foreground: typeTone },
      { token: 'typeParameter', foreground: typeTone },
      { token: 'parameter', foreground: paramTone },
      { token: 'variable', foreground: fg },
      { token: 'property', foreground: paramTone },
      { token: 'enumMember', foreground: enumTone },
      { token: 'decorator', foreground: accent },
      { token: 'event', foreground: fg },
      { token: 'function', foreground: accent },
      { token: 'method', foreground: accent },
      { token: 'member', foreground: accent },
      { token: 'macro', foreground: accent },
      { token: 'keyword', foreground: kw },
      { token: 'modifier', foreground: kw },
      { token: 'comment', foreground: mut },
      { token: 'string', foreground: str },
      { token: 'number', foreground: num },
      { token: 'regexp', foreground: 'D16969' },
      { token: 'operator', foreground: fg },
      { token: 'label', foreground: fg },
      // TS / Py modifiers (selector is type + '.' + sorted modifier names)
      { token: 'variable.readonly', foreground: mut },
      { token: 'property.readonly', foreground: mut },
      { token: 'parameter.readonly', foreground: mut },
      { token: 'variable.defaultLibrary', foreground: enumTone },
      { token: 'function.defaultLibrary', foreground: enumTone },
      { token: 'method.defaultLibrary', foreground: enumTone },
      { token: 'function.async', foreground: accent },
      { token: 'method.async', foreground: accent },
    ];
    return rules;
  }

  private defineClaraTheme(monacoApi: typeof Monaco): void {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const bg = pick('--t-code-bg', '#1a1a1a');
    const fg = pick('--t-code-text', '#d4d4d4');
    const line = pick('--t-border-subtle', '#333333');
    const selection = pick('--t-selection-bg', '#264f78');
    const accent = pick('--t-primary', '#00ff41');
    const typeTone = pick('--t-code-type', '#4EC9B0');
    const paramTone = pick('--t-code-param', '#9CDCFE');
    monacoApi.editor.defineTheme('clara-monaco', {
      base: 'vs-dark',
      inherit: true,
      rules: this.claraSemanticTokenRules(),
      colors: {
        'editor.background': bg,
        'editor.foreground': fg,
        'editorLineNumber.foreground': pick('--t-text-muted', '#858585'),
        'editor.lineHighlightBackground': pick('--t-hover-bg', '#ffffff0c'),
        'editorCursor.foreground': accent,
        'editor.selectionBackground': selection,
        'editor.inactiveSelectionBackground': selection + '99',
        'editorWhitespace.foreground': line,
        'editorIndentGuide.background': line,
        'editorIndentGuide.activeBackground': pick('--t-border', '#555'),
      },
    });
  }

  private async bootstrapEditor(): Promise<void> {
    const monacoApi = await import('monaco-editor');
    this.monaco = monacoApi;
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
    // Built-in TS/JS worker hover (QuickInfo) still runs by default and merges with our LSP
    // hover — same symbol appears twice. Workspace IntelliSense uses the LSP bridge only.
    const tsDefaults = monacoApi.languages.typescript.typescriptDefaults;
    const jsDefaults = monacoApi.languages.typescript.javascriptDefaults;
    tsDefaults.setModeConfiguration({ ...tsDefaults.modeConfiguration, hovers: false });
    jsDefaults.setModeConfiguration({ ...jsDefaults.modeConfiguration, hovers: false });
    this.defineClaraTheme(monacoApi);
    const host = this.editorHost().nativeElement;
    const { settings } = normalizeMonacoWorkspaceEditorSettings(this.editorSettings() == null ? undefined : this.editorSettings()!);
    const mapped = monacoWorkspaceSettingsToEditorOptions(settings);
    // Monaco standalone only honors the dotted global-style key (see monaco-editor#1833);
    // `semanticHighlighting: true` is ignored and semantic tokens are never painted.
    const editorOptions = {
      ...mapped,
      theme: settings.theme,
      automaticLayout: true,
      'semanticHighlighting.enabled': true,
    } as Monaco.editor.IStandaloneEditorConstructionOptions & {
      'semanticHighlighting.enabled'?: boolean;
    };
    this.editor = monacoApi.editor.create(host, editorOptions);
    this.editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      void this.saveCurrent();
    });
    this.wireEditorSelectionListener();
    this.registerWorkspaceLspHoverProviders(monacoApi);
    this.lspLanguageDisposable?.dispose();

    this.lspLanguageDisposable = registerWorkspaceMonacoLsp({
      monacoApi,
      electron: this.electron,
      getConversationId: () => this.conversationId()?.trim() ?? null,
      getWorkspaceRelativePathForModel: (m) => this.workspaceRelativePathForModel(m),
      onNavigateToWorkspaceFile: (p) => this.navigateWorkspaceFile.emit(p),
      semanticLegendsByServer: this.semanticLegendsByServer,
    });
    this.editorReady.set(true);
    this.emitDirtyPaths();
  }

  private workspaceRelativePathForModel(model: Monaco.editor.ITextModel): string | undefined {
    for (const [k, m] of this.modelByPath) {
      if (m === model) {
        return relativePathFromModelKey(k) ?? undefined;
      }
    }
    return undefined;
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
    const ed = this.editor;
    if (!ed || this.monacoDiffActive()) {
      this.zone.run(() => this.editorSelectionChange.emit(null));
      return;
    }
    const model = ed.getModel();
    if (!model) {
      this.zone.run(() => this.editorSelectionChange.emit(null));
      return;
    }
    const rel = this.workspaceRelativePathForModel(model);
    if (!rel?.trim()) {
      this.zone.run(() => this.editorSelectionChange.emit(null));
      return;
    }
    const selection = ed.getSelection();
    if (!selection || selection.isEmpty()) {
      this.zone.run(() => this.editorSelectionChange.emit(null));
      return;
    }
    let modelKey: string | undefined;
    for (const [k, m] of this.modelByPath) {
      if (m === model) {
        modelKey = k;
        break;
      }
    }
    if (!modelKey || isExternalModelKey(modelKey)) {
      this.zone.run(() => this.editorSelectionChange.emit(null));
      return;
    }
    const relNorm = normalizePathSlashes(rel.trim());
    const absFromRef = this.fileRefByKey.get(modelKey)?.absolutePath?.trim();
    const root = this.workspacePath().trim();
    const abs =
      absFromRef ||
      (root ? `${normalizePathSlashes(root).replace(/\/+$/, '')}/${relNorm}` : '');
    if (!abs) {
      this.zone.run(() => this.editorSelectionChange.emit(null));
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
    this.zone.run(() => this.editorSelectionChange.emit(payload));
  }

  private async prefetchSemanticLegendForModel(model: Monaco.editor.ITextModel): Promise<void> {
    const lang = model.getLanguageId();
    if (lang !== 'typescript' && lang !== 'javascript') {
      return;
    }
    const convId = this.conversationId()?.trim();
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

  /** Bridges Monaco hover to the session LSP; models use ``clara-workspace`` URIs only. */
  private registerWorkspaceLspHoverProviders(monacoApi: typeof Monaco): void {
    for (const d of this.lspHoverDisposables) {
      d.dispose();
    }
    this.lspHoverDisposables = [];
    if (!this.electron.isElectron) {
      return;
    }
    for (const lang of LSP_MONACO_LANGUAGE_IDS) {
      this.lspHoverDisposables.push(
        monacoApi.languages.registerHoverProvider(lang, {
          provideHover: (model, position) => this.provideWorkspaceLspHover(model, position),
        }),
      );
    }
  }

  private async provideWorkspaceLspHover(
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ): Promise<Monaco.languages.Hover | null> {
    if (!this.electron.isElectron) {
      return null;
    }
    if (model.uri.scheme !== 'clara-workspace') {
      return null;
    }
    let relKey: string | undefined;
    for (const [k, m] of this.modelByPath) {
      if (m === model) {
        relKey = relativePathFromModelKey(k) ?? undefined;
        break;
      }
    }
    if (!relKey || !lspServerKindForWorkspaceRelativePath(relKey)) {
      return null;
    }
    const sessionId = this.conversationId()?.trim();
    if (!sessionId) {
      return null;
    }
    const skipSync = !monacoModelNeedsLspDocumentSync(model);
    const res = await this.electron.lspEditorHover(
      sessionId,
      relKey,
      position.lineNumber,
      position.column,
      skipSync ? '' : model.getValue(),
      skipSync,
    );
    if (!res.ok || !res.markdown?.trim()) {
      return null;
    }
    if (!skipSync) {
      markMonacoModelLspDocumentSynced(model);
    }
    return {
      contents: [{ value: res.markdown, isTrusted: true }],
    };
  }

  private disposeDiffSurface(): void {
    this.diffEditor?.dispose();
    this.diffEditor = null;
    if (this.diffOriginalModel && !this.diffOriginalModel.isDisposed()) {
      this.diffOriginalModel.dispose();
    }
    this.diffOriginalModel = null;
    if (this.diffModifiedModel && !this.diffModifiedModel.isDisposed()) {
      this.diffModifiedModel.dispose();
    }
    this.diffModifiedModel = null;
    this.diffMountedPayloadKey = '';
  }

  private async mountOrUpdateDiffEditor(workspaceRoot: string, modelKey: string, payload: FileDiffPayload): Promise<void> {
    const monacoApi = this.monaco;
    if (!monacoApi) {
      return;
    }
    const payloadKey = this.pendingDiffReview.sessionKey(payload);
    const wsModel = await this.getOrCreateModel(workspaceRoot, modelKey);
    const displayPath = relativePathFromModelKey(modelKey) ?? displayPathForModelKey(modelKey);
    const baseline =
      typeof payload.fullOriginalContent === 'string'
        ? payload.fullOriginalContent
        : (wsModel?.getValue() ?? '');
    if (!baseline && !wsModel) {
      this.loadError.set('Failed to load original text for diff.');
      return;
    }

    const session = this.pendingDiffReview.sessionFor(payload);
    const modifiedText = mergedContentForDiffPreview(payload, session.accepted(), session.skipped());
    const lang = this.languageIdForPath(monacoApi, displayPath);
    const { settings } = normalizeMonacoWorkspaceEditorSettings(this.editorSettings() == null ? undefined : this.editorSettings()!);
    const mapped = monacoWorkspaceSettingsToEditorOptions(settings);

    const host = this.diffHost().nativeElement;

    if (!this.diffEditor || this.diffMountedPayloadKey !== payloadKey) {
      this.disposeDiffSurface();
      this.diffMountedPayloadKey = payloadKey;
      this.diffEditor = monacoApi.editor.createDiffEditor(host, {
        ...mapped,
        theme: settings.theme,
        automaticLayout: true,
        readOnly: true,
        renderSideBySide: true,
      });
      if (settings.theme === 'clara-monaco') {
        this.defineClaraTheme(monacoApi);
      }
      monacoApi.editor.setTheme(settings.theme);

      this.diffOriginalModel = monacoApi.editor.createModel(
        baseline,
        lang,
        monacoApi.Uri.parse(`clara-diff-org://${encodeURI(displayPath)}`),
      );
      this.diffModifiedModel = monacoApi.editor.createModel(
        modifiedText,
        lang,
        monacoApi.Uri.parse(`clara-diff-mod://${encodeURI(displayPath)}`),
      );
      this.diffEditor.setModel({
        original: this.diffOriginalModel,
        modified: this.diffModifiedModel,
      });
    } else {
      if (this.diffOriginalModel && !this.diffOriginalModel.isDisposed() && this.diffOriginalModel.getValue() !== baseline) {
        this.diffOriginalModel.setValue(baseline);
      }
      if (this.diffModifiedModel && !this.diffModifiedModel.isDisposed() && this.diffModifiedModel.getValue() !== modifiedText) {
        this.diffModifiedModel.setValue(modifiedText);
      }
    }

    this.diffEditor.layout();
    this.loadError.set('');
  }

  private ensureModelDirtyListener(key: string, model: Monaco.editor.ITextModel): void {
    this.modelDirtyDisposables.get(key)?.dispose();
    const d = model.onDidChangeContent(() => this.emitDirtyPaths());
    this.modelDirtyDisposables.set(key, d);
  }

  private emitDirtyPaths(): void {
    const list: string[] = [];
    for (const [key, model] of this.modelByPath) {
      if (model.isDisposed()) {
        continue;
      }
      const synced = this.diskSyncedAltVersionByPath.get(key);
      if (synced === undefined) {
        continue;
      }
      if (model.getAlternativeVersionId() !== synced) {
        list.push(key);
      }
    }
    list.sort();
    this.zone.run(() => this.unsavedPathsChange.emit(list));
  }

  /**
   * Loads or creates a text model for {@param modelKey} without attaching the standalone editor.
   */
  private async getOrCreateModel(workspaceRoot: string, modelKey: string): Promise<Monaco.editor.ITextModel | null> {
    const monacoApi = this.monaco;
    if (!monacoApi) {
      return null;
    }
    let model = this.modelByPath.get(modelKey);
    if (!model || model.isDisposed()) {
      this.loadError.set('');
      const ref = this.fileRefByKey.get(modelKey);
      const displayPath = displayPathForModelKey(modelKey);
      let content: string | undefined;
      if (isExternalModelKey(modelKey)) {
        const abs = absolutePathFromModelKey(modelKey) ?? ref?.absolutePath;
        if (!abs) {
          this.loadError.set('No external file path.');
          return null;
        }
        const res = await this.electron.readAbsoluteFile(abs);
        if (!res.ok || res.content === undefined) {
          this.loadError.set(res.error ?? 'Failed to read file.');
          return null;
        }
        content = res.content;
      } else if (this.detachedByKey.has(modelKey)) {
        const d = this.detachedByKey.get(modelKey)!;
        const res = await this.electron.readAbsoluteFile(d.tempAbsolutePath);
        if (!res.ok || res.content === undefined) {
          this.loadError.set(res.error ?? 'Failed to read detached snapshot.');
          return null;
        }
        content = res.content;
      } else {
        const rel = relativePathFromModelKey(modelKey);
        if (!rel) {
          return null;
        }
        const res = await this.electron.readWorkspaceFile(workspaceRoot, rel);
        if (!res.ok || res.content === undefined) {
          if (this.modelByPath.has(modelKey)) {
            await this.detachModel(modelKey, rel);
            return this.modelByPath.get(modelKey) ?? null;
          }
          this.loadError.set(res.error ?? 'Failed to read file.');
          return null;
        }
        content = res.content;
      }
      const lang = this.languageIdForPath(monacoApi, displayPath);
      const uri = isExternalModelKey(modelKey)
        ? monacoApi.Uri.parse(`clara-external:///${encodeURI(absolutePathFromModelKey(modelKey) ?? displayPath)}`)
        : monacoApi.Uri.parse(`clara-workspace:///${encodeURI(relativePathFromModelKey(modelKey) ?? displayPath)}`);
      model = monacoApi.editor.createModel(content, lang, uri);
      this.modelByPath.set(modelKey, model);
      this.diskSyncedAltVersionByPath.set(modelKey, model.getAlternativeVersionId());
    }
    this.ensureModelDirtyListener(modelKey, model);
    return model;
  }

  private async syncActiveModel(workspaceRoot: string, modelKey: string): Promise<void> {
    const monacoApi = this.monaco;
    const ed = this.editor;
    if (!monacoApi || !ed) {
      return;
    }
    const model = await this.getOrCreateModel(workspaceRoot, modelKey);
    if (!model) {
      return;
    }
    if (this.detachedByKey.has(modelKey)) {
      this.updateDetachedBanner(modelKey);
    } else {
      this.detachedBanner.set('');
    }
    this.loadError.set('');
    ed.setModel(model);
    ed.updateOptions({
      'semanticHighlighting.enabled': true,
    } as Monaco.editor.IEditorOptions & { 'semanticHighlighting.enabled'?: boolean });
    void this.prefetchSemanticLegendForModel(model);
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
      ed.focus();
    }
    this.emitDirtyPaths();
  }

  private async promptSaveAs(modelKey: string): Promise<string | null> {
    const root = this.workspacePath()?.trim();
    const model = this.modelByPath.get(modelKey);
    if (!root || !model || model.isDisposed()) {
      return null;
    }
    const detached = this.detachedByKey.get(modelKey);
    const defaultRel =
      detached?.defaultRelativePath ??
      relativePathFromModelKey(modelKey) ??
      displayPathForModelKey(modelKey);
    const content = model.getValue();
    const res = await this.electron.promptSaveEditorFile(root, defaultRel, content);
    if (!res.ok) {
      if (!res.cancelled) {
        this.loadError.set(res.error ?? 'Save failed.');
      }
      return null;
    }
    await this.cleanupDetachedSnapshot(modelKey);
    this.detachedByKey.delete(modelKey);
    this.emitDetachedPaths();
    this.detachedBanner.set('');

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
    } else {
      this.diskSyncedAltVersionByPath.set(oldKey, model.getAlternativeVersionId());
    }

    this.emitOutsideWorkspacePaths();
    this.emitDirtyPaths();
    this.loadError.set('');
    this.zone.run(() =>
      this.saveAsCompleted.emit({
        oldModelKey: oldKey,
        relativePath: res.relativePath,
        absolutePath: res.absolutePath,
        outsideWorkspace: !!res.outsideWorkspace,
      }),
    );
    return newKey;
  }

  private async saveCurrent(): Promise<void> {
    const ed = this.editor;
    const root = this.workspacePath()?.trim();
    const modelKey = this.activeModelKey()?.trim();
    if (!ed || !root || !modelKey) {
      return;
    }
    const model = ed.getModel();
    if (!model || this.modelByPath.get(modelKey) !== model) {
      return;
    }
    if (this.detachedByKey.has(modelKey)) {
      await this.promptSaveAs(modelKey);
      return;
    }
    const content = model.getValue();
    if (isExternalModelKey(modelKey)) {
      const abs = absolutePathFromModelKey(modelKey);
      if (!abs) {
        return;
      }
      const res = await this.electron.writeAbsoluteFile(abs, content);
      if (!res.ok) {
        this.loadError.set(res.error ?? 'Save failed.');
        return;
      }
    } else {
      const rel = relativePathFromModelKey(modelKey);
      if (!rel) {
        return;
      }
      const res = await this.electron.writeWorkspaceFile(root, rel, content);
      if (!res.ok) {
        this.loadError.set(res.error ?? 'Save failed.');
        return;
      }
    }
    this.diskSyncedAltVersionByPath.set(modelKey, model.getAlternativeVersionId());
    this.loadError.set('');
    this.emitDirtyPaths();
  }
}
