/**
 * Main chat shell: conversations, workspace chrome, IPC-driven streaming, and layout resize handles.
 * TTS playback lives in {@link TtsPlaybackService}; this component wires signals and `ElectronService` streams.
 */
import { afterNextRender, Component, computed, effect, HostListener, inject, Injector, model, NgZone, OnDestroy, OnInit, signal, untracked, ViewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  ChatStructuredContentPart,
  ConversationFileJournalEntry,
  ComposerRunMode,
  FileDiffPayload,
  StagedTransferBatchPayload,
  Workspace,
  WorkspaceFilesChangedMessage,
  LspEditorDiagnostic,
  LlmConnectionConfig,
  LlmReasoningSettingChange,
} from '@shared/index';
import {
  fallbackJournalFromMessages,
  invertJournalEntries,
  journalPreviewPaths,
  journalUserIdsToInvert,
  resolveRestoreUserIndex,
  DEFAULT_COMPOSER_RUN_MODE,
  DEFAULT_KOKORO_TTS_VOICE,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_TTS_PROVIDER,
  composerApplyMode,
  composerModeForBackend,
  effectiveLmStudioContextTokens,
  patchLlmModelProfile,
  resolveActiveLlmConnection,
  resolveChatWindowState,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
  unwrapSecret,
} from '@shared/index';
import { ChatActiveStackComponent } from '../chat/chat-active-stack/chat-active-stack';
import { ChatConversationHubComponent } from '../chat/chat-conversation-hub/chat-conversation-hub';
import type { ChatMessage } from '../chat/chat-box/chat-box';
import {
  type ChatContextFile,
  chatContextFileFromEditorSelection,
  chatContextFileKey,
  chatContextFilesEqual,
  formatAttachedFileText,
  formatAttachedImageText,
  structuredContentForBackendRequest,
  isImagePath,
  type EditorSelectionPayload,
} from '../chat/chat-context-bar/chat-context-file';
import type { ChatContextDroppedPath } from '../chat/chat-context-bar/chat-context-drop';
import { ConversationSessionService, pickTtsFlushText } from './conversation-session.service';
import { abandonStaleHitlMessages } from './abandon-stale-hitl';
import { conversationRestorePrompt } from '../../shared/themed-confirm-dialog/format-restore-prompt';

export { pickTtsFlushText };
import {
  chatFileTabBasename,
  chatFileTabId,
  chatFileTabModelKey,
  allFileTabIds,
  deactivateBuildPlanTab,
  fileTabIdsToLeft,
  fileTabIdsToRight,
  findTabByModelKey,
  openEditorFileRefFromTab,
  openTabForRenamedFile,
  removeBuildPlanTab,
  replaceFileTabAfterSaveAs,
  reorderFileTabs,
  retargetFileTabPath,
  type ChatFileTab,
  workspaceChatFileTab,
  buildPlanChatFileTab,
} from './app-chat-file-tabs';
import { relativePathFromModelKey } from '../workspace/open-editor-file-ref';
import { applyAppFontOverrides, applyAppTheme, resolveAppThemeId } from './app-theme';
import { SETTINGS_TABS, type SettingsTab } from '../settings/settings/settings-tabs';
import {
  buildContextCapacitySnapshot,
  CONTEXT_CHAT_BLOCKED_PERCENT,
  estimateTranscriptContextTokens,
} from '../status/context-capacity/context-capacity.utils';
import { EditorLspStatusComponent } from './editor-lsp-status/editor-lsp-status';
import { LlamaStatusIndicator } from '../status/llama-status-indicator/llama-status-indicator';
import { MainPanelEmptyStateComponent } from './main-panel-empty-state/main-panel-empty-state';
import { WorkspaceComponent } from '../workspace/workspace/workspace';
import { WorkspaceMonacoComponent } from '../workspace/workspace-monaco/workspace-monaco';
import type { EditorOutlineSymbol } from '../workspace/editor-outline/editor-outline';
import { editorModelKeyForRelativePath } from '../workspace/open-editor-file-ref';
import { ImageViewerComponent } from '../workspace/image-viewer/image-viewer';
import { isViewableImagePath } from '../workspace/image-viewer/image-viewer-formats';
import { planOpenWorkspaceImageTab } from './app-image-file-tabs';
import { WorkspaceTerminalDockComponent } from '../workspace-terminal/workspace-terminal-dock';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { ThemedConfirmDialogService } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { PendingDiffReviewService } from '../diff/pending-diff-review.service';
import { ThemedConfirmDialogComponent } from '../../shared/themed-confirm-dialog/themed-confirm-dialog';
import { ThemedPromptDialogComponent } from '../../shared/themed-prompt-dialog/themed-prompt-dialog';
import {
  activeStreamWorkspaceSwitchPrompt,
  unsavedCloseFileTabPrompt,
  unsavedWorkspaceSwitchPrompt,
  detachedFileClosePrompt,
  activeBuildPlanClosePrompt,
} from '../../shared/themed-confirm-dialog/format-unsaved-workspace-detail';
import { normalizePathSlashes, workspaceRelativePathIfUnderRoot } from '../../utils/workspace-relative-path';
import { LucideAngularModule } from 'lucide-angular';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';

const NEW_CONV_EXPANDED_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'medium' as const,
  color: 'var(--t-primary)',
  type: 'ball-atom' as const,
};

function parentRelativePath(relativePath: string): string {
  const norm = normalizePathSlashes(relativePath);
  const slash = norm.lastIndexOf('/');
  return slash >= 0 ? norm.slice(0, slash) : '';
}

@Component({
  selector: 'app-root',
  imports: [
    ChatActiveStackComponent,
    ChatConversationHubComponent,
    EditorLspStatusComponent,
    LlamaStatusIndicator,
    MainPanelEmptyStateComponent,
    LucideAngularModule,
    WorkspaceComponent,
    WorkspaceMonacoComponent,
    ImageViewerComponent,
    WorkspaceTerminalDockComponent,
    ThemedConfirmDialogComponent,
    ThemedPromptDialogComponent,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    NgxSpinnerComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  @ViewChild(WorkspaceMonacoComponent) private workspaceMonaco?: WorkspaceMonacoComponent;
  private readonly ngxSpinner = inject(NgxSpinnerService);
  private readonly inj = inject(Injector);
  private shellDestroyed = false;
  protected readonly newConvExpandedSpinnerName = 'new-conv-expanded';
  protected readonly conversationSession = inject(ConversationSessionService);
  protected readonly messages = this.conversationSession.messages;
  protected readonly pendingIds = this.conversationSession.pendingIds;
  protected readonly loading = this.conversationSession.loading;
  protected readonly conversations = this.conversationSession.conversations;
  protected readonly activeConversationId = this.conversationSession.activeConversationId;
  protected readonly streamingParts = this.conversationSession.streamingParts;
  protected readonly streamingPlanner = this.conversationSession.streamingPlanner;
  protected readonly streamingFinalText = this.conversationSession.streamingFinalText;
  protected readonly chatHubView = this.conversationSession.chatHubView;
  protected readonly processingToolsActive = this.conversationSession.processingToolsActive;
  protected readonly creatingConversation = this.conversationSession.creatingConversation;

  protected readonly appConfig = signal<AppConfig | null>(null);
  protected readonly pinned = model(false);
  protected readonly fontSize = model(0.9);
  protected readonly speechEnabled = model(false);
  protected readonly selectedVoice = model(DEFAULT_KOKORO_TTS_VOICE);
  protected readonly ttsSpeechSpeed = signal(TTS_SPEECH_SPEED_DEFAULT);
  protected readonly talkStatus = model('');
  /** Errors / hints from talk capture (shown in composer status row). */
  protected readonly talkModeDetailStatus = model('');
  protected readonly talkEnabled = model(false);
  /** When true, backend applies proposed edits immediately without diff review pause (`auto_apply_mode`). */
  protected readonly autoApplyMode = model(false);
  /** Composer run mode: agent (ReAct), ask (read-only), or plan (plan-and-execute). */
  protected readonly composerMode = model<ComposerRunMode>(DEFAULT_COMPOSER_RUN_MODE);
  /** Shared composer draft (restore puts the selected user prompt back here). */
  protected readonly composerDraft = model('');
  /** Live build-plan markdown streamed from the planner before finalize. */
  protected readonly buildPlanLiveContent = signal<{ relativePath: string; content: string } | null>(null);
  /** Monaco model keys currently receiving live build-plan chunks (skip disk reload). */
  protected readonly buildPlanStreamingKeys = signal<ReadonlySet<string>>(new Set());
  /** Active build plan per conversation (preview tab + cancel lifecycle). */
  private readonly activeBuildPlanByConversation = new Map<
    string,
    { planId: string; relativePath: string; active: boolean }
  >();
  /**
   * Last measured prompt token count per conversation (from API usage metadata, or that
   * value adjusted by a mid/post-turn compaction delta). Kept across chat switches in this
   * session — the UI transcript heuristic can dwarf the real prompt after compaction / HITL
   * cards, and falling back to it on reload falsely reports 100% and locks the composer.
   */
  protected readonly measuredPromptTokensByConversation = signal<Record<string, number>>({});
  /**
   * Transcript heuristic at the moment ``measuredPromptTokensByConversation`` was last set.
   * Growth above this is added so the meter keeps updating while tools stream after a measurement.
   */
  protected readonly measuredBaselineFallbackByConversation = signal<Record<string, number>>({});
  protected readonly activeMeasuredPromptTokens = computed(() => {
    const id = this.activeConversationId();
    if (!id) {
      return null;
    }
    const tokens = this.measuredPromptTokensByConversation()[id];
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  });
  protected readonly activeMeasuredBaselineFallbackTokens = computed(() => {
    const id = this.activeConversationId();
    if (!id) {
      return null;
    }
    const tokens = this.measuredBaselineFallbackByConversation()[id];
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
  });
  /** Main window zoom state (frameless window controls). */
  protected readonly windowMaximized = signal(false);

  // Workspace management
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly currentWorkspaceId = signal<string | null>(null);
  protected readonly workspaceContextText = signal('');
  protected readonly currentWorkspace = computed(() => {
    const id = this.currentWorkspaceId();
    return this.workspaces().find(w => w.id === id) ?? null;
  });
  protected readonly currentWorkspacePath = computed(() => this.currentWorkspace()?.path?.trim() ?? '');
  /** Open file tabs (paths relative to current workspace). */
  protected readonly fileTabs = signal<ChatFileTab[]>([]);
  /** Files attached to the next chat turn (images sent inline; others referenced by path). */
  protected readonly chatContextFiles = signal<ChatContextFile[]>([]);
  /** Unpinned editor line-range chip (cleared on file switch). */
  protected readonly editorSelectionChip = signal<ChatContextFile | null>(null);
  /** Staged attachments shown in the composer (pinned + ephemeral selection). */
  protected readonly composerContextFiles = computed(() => {
    const pinned = this.chatContextFiles();
    const ephemeral = this.editorSelectionChip();
    if (!ephemeral) {
      return pinned;
    }
    if (pinned.some((f) => chatContextFileKey(f) === chatContextFileKey(ephemeral))) {
      return pinned;
    }
    return [...pinned, ephemeral];
  });
  protected readonly composerAttachmentCount = computed(() => this.composerContextFiles().length);
  /** Model keys with unsaved Monaco buffers (mirrors main process for workspace-switch confirm). */
  protected readonly monacoUnsavedPaths = signal<ReadonlySet<string>>(new Set());
  protected readonly monacoDetachedPaths = signal<ReadonlySet<string>>(new Set());
  /** One-shot scroll target after cross-file go-to-definition from Monaco. */
  protected readonly monacoRevealPending = signal<{
    relativePath: string;
    line: number;
    column: number;
  } | null>(null);
  /** Document outline symbols for the active Monaco tab (sidebar footer panel). */
  protected readonly monacoOutlineState = signal<{
    relativePath: string | null;
    symbols: readonly EditorOutlineSymbol[];
  }>({ relativePath: null, symbols: [] });
  /** LSP diagnostics for the active Monaco tab (terminal dock Problems tab). */
  protected readonly monacoDiagnosticsState = signal<{
    relativePath: string | null;
    diagnostics: readonly LspEditorDiagnostic[];
  }>({ relativePath: null, diagnostics: [] });
  /** Open file tab id (`file:<relativePath>`) or null when no editor tab is selected. */
  protected readonly activeMainTabId = signal<string | null>(null);
  protected readonly fileTabContextMenuVisible = signal(false);
  protected readonly fileTabContextMenuX = signal(0);
  protected readonly fileTabContextMenuY = signal(0);
  protected readonly fileTabContextMenuTabId = signal<string | null>(null);
  /** Titlebar Settings dropdown (`null` when closed). */
  protected readonly chromeMenu = signal<'settings' | null>(null);
  protected readonly chromeMenuX = signal(0);
  protected readonly chromeMenuY = signal(0);
  protected readonly chromeSettingsTabs = SETTINGS_TABS;
  protected readonly chromeAccelMod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
    ? '⌘'
    : 'Ctrl';
  protected readonly fileTabContextMenuCanCloseLeft = computed(() => {
    const tabId = this.fileTabContextMenuTabId();
    if (!tabId) {
      return false;
    }
    return fileTabIdsToLeft(this.fileTabs(), tabId).length > 0;
  });
  protected readonly fileTabContextMenuCanCloseRight = computed(() => {
    const tabId = this.fileTabContextMenuTabId();
    if (!tabId) {
      return false;
    }
    return fileTabIdsToRight(this.fileTabs(), tabId).length > 0;
  });
  /** When true, active chat stack overlays the main editor stage. */
  protected readonly chatExpanded = model(false);
  /** When true, the chat sidebar collapses to a thin bar holding only the un-collapse button. */
  protected readonly chatCollapsed = model(false);
  /** Skip persisting chat chrome until the first config load has hydrated the signals. */
  private chatLayoutHydrated = false;

  /** Width of the sidebar when the chat is collapsed (just the un-collapse button + padding). */
  private static readonly CHAT_COLLAPSED_WIDTH_PX = 48;
  protected readonly effectiveSidebarWidth = computed(() =>
    this.chatCollapsed() ? App.CHAT_COLLAPSED_WIDTH_PX : this.sidebarWidth(),
  );

  protected readonly openFileRelativePaths = computed(() =>
    this.fileTabs()
      .map((t) => t.relativePath)
      .filter((p): p is string => !!p?.trim()),
  );

  protected readonly monacoOpenEditorFiles = computed(() =>
    this.fileTabs()
      .map((t) => openEditorFileRefFromTab(t))
      .filter((f): f is NonNullable<typeof f> => {
        if (!f) {
          return false;
        }
        if (f.outsideWorkspace) {
          return true;
        }
        return !isViewableImagePath(f.relativePath ?? '');
      }),
  );

  protected readonly activeModelKey = computed(() => {
    const tabId = this.activeMainTabId();
    if (!tabId?.startsWith('file:')) {
      return null;
    }
    return tabId.slice(5) || null;
  });

  protected readonly mainStageShowsEmptyState = computed(
    () => this.activeMainTabId() === null && !this.chatExpanded(),
  );

  protected readonly activeFileRelativePath = computed(() => {
    const key = this.activeModelKey();
    if (!key) {
      return null;
    }
    return relativePathFromModelKey(key);
  });

  /** True when the active Monaco tab has unsaved buffer edits. */
  protected readonly activeFileIsDirty = computed(() => {
    const key = this.activeModelKey();
    return !!key && this.monacoUnsavedPaths().has(key);
  });

  /** True when the active file tab is an image the dedicated viewer should render. */
  protected readonly activeFileIsImage = computed(() => {
    const p = this.activeFileRelativePath();
    return !!p && isViewableImagePath(p);
  });

  /**
   * Bound into the image viewer. Null for text tabs so the still-mounted
   * (CSS-hidden) viewer does not fetch `nemo-asset://` for non-images.
   */
  protected readonly imageViewerRelativePath = computed(() =>
    this.activeFileIsImage() ? this.activeFileRelativePath() : null,
  );

  /** Active file path for Monaco only — image tabs are routed to the image viewer instead. */
  protected readonly monacoActiveModelKey = computed(() =>
    this.activeFileIsImage() ? null : this.activeModelKey(),
  );

  protected readonly monacoActiveFileRelativePath = computed(() =>
    this.activeFileIsImage() ? null : this.activeFileRelativePath(),
  );

  protected readonly monacoOpenFileRelativePaths = computed(() =>
    this.openFileRelativePaths().filter((p) => !isViewableImagePath(p)),
  );

  /** Model keys for build-plan tabs that should open in preview-only mode. */
  protected readonly monacoForcePreviewKeys = computed(() => {
    const keys = new Set<string>();
    for (const tab of this.fileTabs()) {
      if (tab.previewOnly) {
        const key = chatFileTabModelKey(tab);
        if (key) {
          keys.add(key);
        }
      }
    }
    return keys;
  });

  /** Persisted Monaco scroll positions for the active workspace. */
  protected readonly workspaceMonacoScrollByPath = computed(() => {
    const wsId = this.currentWorkspaceId();
    if (!wsId) {
      return {};
    }
    return this.appConfig()?.workspaceMonacoScrollByWorkspaceId?.[wsId] ?? {};
  });

  /** Latest pending file diff for the currently focused editor tab (Monaco inline review). */
  protected readonly pendingDiffForActiveEditor = computed((): FileDiffPayload | null => {
    const path = this.activeFileRelativePath();
    if (!path?.trim()) {
      return null;
    }
    const norm = normalizePathSlashes(path.trim());
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'staged_transfer_batch' && (m.reviewStatus ?? 'pending') === 'pending') {
        const resolutions = this.mergedStagedTransferBatchResolutions(m.payload, m.fileResolutions);
        for (const file of m.payload.files) {
          if (normalizePathSlashes(file.relativePath) === norm) {
            const res = resolutions[file.relativePath] ?? 'pending';
            if (res === 'pending') {
              return file;
            }
          }
        }
      }
      if (m.role === 'diff' && (m.reviewStatus ?? 'pending') === 'pending') {
        if (normalizePathSlashes(m.payload.relativePath) === norm) {
          return m.payload;
        }
      }
    }
    return null;
  });

  /** Batch context when the active editor tab is reviewing one file in a staged-transfer batch. */
  protected readonly pendingStagedTransferBatchForActiveEditor = computed((): StagedTransferBatchPayload | null => {
    const path = this.activeFileRelativePath();
    if (!path?.trim()) {
      return null;
    }
    const norm = normalizePathSlashes(path.trim());
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'staged_transfer_batch' || (m.reviewStatus ?? 'pending') !== 'pending') {
        continue;
      }
      const resolutions = this.mergedStagedTransferBatchResolutions(m.payload, m.fileResolutions);
      for (const file of m.payload.files) {
        if (normalizePathSlashes(file.relativePath) === norm) {
          const res = resolutions[file.relativePath] ?? 'pending';
          if (res === 'pending') {
            return m.payload;
          }
        }
      }
    }
    return null;
  });

  protected readonly activeLlmConnection = computed(() => {
    const config = this.appConfig();
    if (!config) {
      return null;
    }
    return resolveActiveLlmConnection(config);
  });
  private readonly llamaServerNctxByModel = toSignal(inject(ElectronService).llamaServerNctx$, {
    initialValue: {} as Readonly<Record<string, number>>,
  });
  protected readonly contextCapacity = computed(() => {
    const conn = this.activeLlmConnection();
    const liveNctx = conn ? this.llamaServerNctxByModel()[conn.id] : undefined;
    const connection =
      conn && typeof liveNctx === 'number' && liveNctx > 0
        ? { ...conn, contextWindowTokens: liveNctx }
        : conn;
    return buildContextCapacitySnapshot({
      connection,
      messages: this.messages(),
      streamingParts: this.streamingParts(),
      workspaceContextText: this.workspaceContextText(),
      measuredPromptTokens: this.activeMeasuredPromptTokens(),
      measuredBaselineFallbackTokens: this.activeMeasuredBaselineFallbackTokens(),
    });
  });
  protected readonly contextChatBlocked = computed(
    () => this.contextCapacity().usedPercentage >= CONTEXT_CHAT_BLOCKED_PERCENT,
  );

  // Layout
  protected readonly workspaceWidth = signal(App.defaultWorkspaceWidthPx());
  protected readonly sidebarWidth = signal(0);

  private static readonly MIN_WORKSPACE = 140;
  private static readonly MAX_WORKSPACE = 500;
  private static readonly MIN_SIDEBAR = 140;
  private static readonly MAX_SIDEBAR = 800;
  private static readonly LAYOUT_RESIZE_HANDLES_PX = 8;
  private static readonly DEFAULT_WORKSPACE_WIDTH_PERCENT = 0.25;
  private static readonly DEFAULT_SIDEBAR_WIDTH_PERCENT = 1 / 3;

  /** Initial workspace pane width: 25% of the viewport (clamped), for a 1:2:1 default layout. */
  private static defaultWorkspaceWidthPx(): number {
    const px = Math.round(window.innerWidth * App.DEFAULT_WORKSPACE_WIDTH_PERCENT);
    return Math.min(App.MAX_WORKSPACE, Math.max(App.MIN_WORKSPACE, px));
  }

  private static readonly SIDEBAR_WIDTH_SAVE_DEBOUNCE_MS = 2000;

  private resizing: 'workspace' | 'sidebar' | null = null;
  private boundOnResizeMove = this.onResizeMove.bind(this);
  private boundOnResizeEnd = this.onResizeEnd.bind(this);
  private boundOnWindowResize = this.onWindowResize.bind(this);
  private sidebarWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSidebarWidthPercent: number | null = null;
  private workspaceSyncToken = 0;
  private lmStudioContextPollTimer: ReturnType<typeof setTimeout> | null = null;
  private lmStudioContextPollGen = 0;
  private static readonly LM_STUDIO_CONTEXT_POLL_MS = 12_000;

  constructor(
    protected readonly electron: ElectronService,
    private zone: NgZone,
    protected readonly tts: TtsPlaybackService,
    private readonly themedConfirm: ThemedConfirmDialogService,
    private readonly pendingDiffReview: PendingDiffReviewService,
  ) {
    this.electron.windowMaximized$
      .pipe(takeUntilDestroyed())
      .subscribe((maximized) => this.windowMaximized.set(maximized));

    this.electron.editorFindRequested$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.onEditorFindRequested());

    this.electron.workspaceFilesChanged$
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        void this.onWorkspaceFilesChangedForEditorTabs(event);
      });

    effect(() => {
      if (!this.speechEnabled()) void this.tts.invalidateSpeechPipeline();
    });

    effect(() => {
      if (!this.talkEnabled()) {
        this.speechEnabled.set(false);
      }
    });

    effect(() => {
      this.electron.setAlwaysOnTop(this.pinned());
    });

    effect(() => {
      const conn = this.activeLlmConnection();
      if (conn?.provider !== 'lmstudio') {
        untracked(() => this.stopLmStudioContextPoll());
        return;
      }
      untracked(() => this.startLmStudioContextPoll(conn));
    });

    effect(() => {
      const convId = this.activeConversationId();
      const mode = this.composerMode();
      const effectiveAutoApply = composerApplyMode(mode) && this.autoApplyMode();
      if (convId) {
        void this.electron.syncAutoApplyMode(convId, effectiveAutoApply);
      }
    });

    effect(() => {
      if (this.composerMode() === 'ask') {
        this.autoApplyMode.set(false);
      }
    });

    effect(() => {
      this.activeModelKey();
      untracked(() => {
        this.editorSelectionChip.set(null);
      });
    });

    effect(() => {
      this.currentWorkspaceId();
      untracked(() => {
        this.fileTabs.set([]);
        this.activeMainTabId.set(null);
        this.clearChatContextFiles();
      });
    });

    effect(() => {
      // Track both workspace and conversation changes to sync workspace context
      // The effect will re-run when either changes, after loadConversationsForWorkspace
      // has had a chance to update activeConversationId
      const ws = this.currentWorkspace();
      const convId = this.activeConversationId();
      if (ws && convId) {
        // Defer to next tick so activeConversationId can update first
        setTimeout(() => {
          if (this.currentWorkspace() && this.activeConversationId()) {
            this.syncWorkspaceContext(ws.path);
          }
        }, 0);
      } else {
        this.workspaceContextText.set('');
      }
    });

    effect(() => {
      this.activeConversationId();
      untracked(() => this.pendingDiffReview.clearAllSessions());
    });

    effect(() => {
      const creating = this.creatingConversation();
      const expanded = this.chatExpanded();
      untracked(() => this.scheduleNewConvExpandedSpinnerSync(creating && expanded));
    });

    effect(() => {
      this.chatCollapsed();
      this.chatExpanded();
      untracked(() => {
        void this.persistChatWindowStateNow();
      });
    });

    this.conversationSession.bindHooks({
      getCurrentWorkspaceId: () => this.currentWorkspaceId(),
      getSpeechSettings: () => ({
        enabled: this.speechEnabled(),
        voice: this.selectedVoice(),
        speed: this.ttsSpeechSpeed(),
      }),
      onPlannerComplete: (conversationId) => this.setBuildPlanTabInactive(conversationId),
    });

    this.electron.llmTokenUsage$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, inputTokens }) => {
      if (inputTokens <= 0) {
        return;
      }
      // token_usage is an absolute measurement of the last prompt sent to the model. Only let it
      // RAISE the meter (or set the initial value). Decreases are driven exclusively by the
      // contextCompressed$ event (mid-turn compaction). Without this guard, a llama.cpp context
      // checkpoint restore reports a lower input_tokens after silently truncating context, which
      // would reset the meter mid-conversation even though the transcript is unchanged.
      const existing = this.measuredPromptTokensByConversation()[conversationId];
      if (
        typeof existing === 'number' &&
        Number.isFinite(existing) &&
        existing > 0 &&
        inputTokens < existing
      ) {
        return;
      }
      this.setMeasuredPromptTokensForConversation(conversationId, inputTokens);
    });

    this.electron.contextCompressed$.pipe(takeUntilDestroyed()).subscribe(
      ({ conversationId, tokensBefore, tokensAfter }) => {
        // Mid-turn estimates are checkpoint-only (no system prompt / tool schemas). Never treat
        // tokensAfter as an absolute measurement — apply the freed delta to the last API reading.
        const freed = Math.max(0, tokensBefore - tokensAfter);
        if (freed <= 0) {
          return;
        }
        const existing = this.measuredPromptTokensByConversation()[conversationId];
        if (typeof existing !== 'number' || !Number.isFinite(existing) || existing <= 0) {
          return;
        }
        this.setMeasuredPromptTokensForConversation(conversationId, Math.max(1, existing - freed));
      },
    );

    this.electron.config$.pipe(takeUntilDestroyed()).subscribe((config) => {
      this.appConfig.set(config);
      const cfs = config.chatFontSizeRem;
      const nextFs =
        typeof cfs === 'number' && !Number.isNaN(cfs) ? Math.min(1.6, Math.max(0.6, +cfs.toFixed(1))) : 0.9;
      this.fontSize.set(nextFs);
      const at = config.audioTranscription;
      const ttsProvider = at?.ttsProvider ?? DEFAULT_TTS_PROVIDER;
      this.tts.setTtsChunkProfile(ttsProvider);
      this.tts.setTtsDefaultInstructions(at?.ttsDefaultInstructions?.trim() || '');
      const defaultVoice =
        ttsProvider === 'openai-compatible' ? DEFAULT_OPENAI_TTS_VOICE : DEFAULT_KOKORO_TTS_VOICE;
      this.selectedVoice.set(at?.ttsVoice?.trim() || defaultVoice);
      const sp = at?.ttsSpeechSpeed;
      this.ttsSpeechSpeed.set(
        typeof sp === 'number' && !Number.isNaN(sp)
          ? Math.min(TTS_SPEECH_SPEED_MAX, Math.max(TTS_SPEECH_SPEED_MIN, sp))
          : TTS_SPEECH_SPEED_DEFAULT,
      );
      applyAppTheme(resolveAppThemeId(config));
      applyAppFontOverrides(config);
      this.workspaces.set(config.workspaces);
      this.currentWorkspaceId.set(config.currentWorkspaceId);
      if (this.pendingSidebarWidthPercent == null && this.resizing !== 'sidebar') {
        this.syncSidebarWidthFromEffectivePercent();
      }
      this.hydrateChatWindowStateFromConfig(config);
    });

    this.electron.buildPlanOpen$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      const planId = payload.planId?.trim();
      const relativePath = payload.relativePath?.trim();
      if (!planId || !relativePath) {
        return;
      }
      const norm = normalizePathSlashes(relativePath);
      this.activeBuildPlanByConversation.set(conversationId, { planId, relativePath: norm, active: true });
      if (conversationId === this.activeConversationId()) {
        this.openOrFocusBuildPlanTab(norm, planId, true);
      }
    });

    this.electron.buildPlanChunk$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (conversationId !== this.activeConversationId()) {
        return;
      }
      const relativePath = payload.relativePath?.trim();
      if (!relativePath) {
        return;
      }
      const norm = normalizePathSlashes(relativePath);
      const modelKey = editorModelKeyForRelativePath(norm);
      this.buildPlanLiveContent.set({ relativePath: norm, content: payload.content });
      this.buildPlanStreamingKeys.update((prev) => {
        const next = new Set(prev);
        next.add(modelKey);
        return next;
      });
    });

    this.electron.buildPlanStreamEnd$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (conversationId !== this.activeConversationId()) {
        return;
      }
      const relativePath = payload.relativePath?.trim();
      if (!relativePath) {
        return;
      }
      const norm = normalizePathSlashes(relativePath);
      const modelKey = editorModelKeyForRelativePath(norm);
      this.buildPlanStreamingKeys.update((prev) => {
        const next = new Set(prev);
        next.delete(modelKey);
        return next;
      });
      const live = this.buildPlanLiveContent();
      if (live && normalizePathSlashes(live.relativePath) === norm) {
        this.buildPlanLiveContent.set(null);
      }
    });

    this.electron.openWorkspace$.pipe(takeUntilDestroyed()).subscribe((workspacePath) => {
      void this.handleOpenWorkspace(workspacePath);
    });

    this.electron.openConversation$.pipe(takeUntilDestroyed()).subscribe((conversationId) => {
      void this.handleOpenConversation(conversationId);
    });
  }

  async ngOnInit(): Promise<void> {
    // Load config which includes workspaces
    const config = await this.electron.loadConfig();
    this.appConfig.set(config);
    this.workspaces.set(config.workspaces);
    this.currentWorkspaceId.set(config.currentWorkspaceId);

    applyAppTheme(resolveAppThemeId(config));
    this.hydrateChatWindowStateFromConfig(config);

    if (this.electron.isElectron) {
      this.windowMaximized.set(await this.electron.windowIsMaximized());
    }

    this.syncSidebarWidthFromEffectivePercent();
    window.addEventListener('resize', this.boundOnWindowResize);

    // Load conversations for current workspace
    await this.loadConversationsForWorkspace();
  }

  ngOnDestroy(): void {
    this.shellDestroyed = true;
    this.stopLmStudioContextPoll();
    void this.ngxSpinner.hide(this.newConvExpandedSpinnerName);
    void this.tts.invalidateSpeechPipeline();
    window.removeEventListener('resize', this.boundOnWindowResize);
    this.flushSidebarWidthPersist();
    this.onResizeEnd();
  }

  private startLmStudioContextPoll(conn: LlmConnectionConfig): void {
    this.stopLmStudioContextPoll();
    const gen = ++this.lmStudioContextPollGen;
    const run = async (): Promise<void> => {
      await this.refreshLmStudioLiveContext(conn);
      if (this.shellDestroyed || gen !== this.lmStudioContextPollGen) {
        return;
      }
      this.lmStudioContextPollTimer = window.setTimeout(() => {
        void run();
      }, App.LM_STUDIO_CONTEXT_POLL_MS);
    };
    void run();
  }

  private stopLmStudioContextPoll(): void {
    this.lmStudioContextPollGen += 1;
    if (this.lmStudioContextPollTimer != null) {
      window.clearTimeout(this.lmStudioContextPollTimer);
      this.lmStudioContextPollTimer = null;
    }
  }

  private async refreshLmStudioLiveContext(conn: LlmConnectionConfig): Promise<void> {
    const gen = this.lmStudioContextPollGen;
    const res = await this.electron.lmStudioListModels({
      baseUrl: conn.baseUrl,
      apiKey: unwrapSecret(conn.apiKey),
    });
    if (this.shellDestroyed || gen !== this.lmStudioContextPollGen || !res.ok) {
      return;
    }
    const card = res.models.find((c) => c.id === conn.model);
    const n = card ? effectiveLmStudioContextTokens(card) : 0;
    this.electron.applyLiveContextWindow(conn.id, n > 0 ? n : undefined);
  }

  private scheduleNewConvExpandedSpinnerSync(show: boolean): void {
    afterNextRender(
      () => {
        if (this.shellDestroyed) {
          return;
        }
        if (show) {
          void this.ngxSpinner.show(this.newConvExpandedSpinnerName, NEW_CONV_EXPANDED_SPINNER);
        } else {
          void this.ngxSpinner.hide(this.newConvExpandedSpinnerName);
        }
      },
      { injector: this.inj },
    );
  }

  private normalizeSidebarWidthPercent(value: number | undefined): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return App.DEFAULT_SIDEBAR_WIDTH_PERCENT;
    }
    const clamped = Math.min(0.95, Math.max(0.05, value));
    return Math.round(clamped * 10_000) / 10_000;
  }

  private effectiveSidebarWidthPercent(): number {
    return (
      this.pendingSidebarWidthPercent ??
      this.appConfig()?.chatSidebarWidthPercent ??
      App.DEFAULT_SIDEBAR_WIDTH_PERCENT
    );
  }

  /** Width of the chat-area + sidebar region (between the two column resize handles). */
  private chatSidebarLayoutWidth(): number {
    return Math.max(
      App.MIN_SIDEBAR,
      window.innerWidth - this.workspaceWidth() - App.LAYOUT_RESIZE_HANDLES_PX,
    );
  }

  private sidebarPixelsForPercent(percent: number): number {
    const layout = this.chatSidebarLayoutWidth();
    const px = Math.round(this.normalizeSidebarWidthPercent(percent) * layout);
    return Math.min(App.MAX_SIDEBAR, Math.max(App.MIN_SIDEBAR, px));
  }

  private percentFromSidebarPixels(widthPx: number): number {
    const layout = this.chatSidebarLayoutWidth();
    if (layout <= 0) {
      return App.DEFAULT_SIDEBAR_WIDTH_PERCENT;
    }
    const clampedPx = Math.min(App.MAX_SIDEBAR, Math.max(App.MIN_SIDEBAR, widthPx));
    return clampedPx / layout;
  }

  private syncSidebarWidthFromEffectivePercent(): void {
    this.sidebarWidth.set(this.sidebarPixelsForPercent(this.effectiveSidebarWidthPercent()));
  }

  private onWindowResize(): void {
    this.syncSidebarWidthFromEffectivePercent();
  }

  private scheduleSidebarWidthPersist(percent: number): void {
    this.pendingSidebarWidthPercent = this.normalizeSidebarWidthPercent(percent);
    if (this.sidebarWidthSaveTimer != null) {
      window.clearTimeout(this.sidebarWidthSaveTimer);
    }
    this.sidebarWidthSaveTimer = window.setTimeout(() => {
      this.sidebarWidthSaveTimer = null;
      void this.flushSidebarWidthPersist();
    }, App.SIDEBAR_WIDTH_SAVE_DEBOUNCE_MS);
  }

  private flushSidebarWidthPersist(): void {
    if (this.sidebarWidthSaveTimer != null) {
      window.clearTimeout(this.sidebarWidthSaveTimer);
      this.sidebarWidthSaveTimer = null;
    }
    const pending = this.pendingSidebarWidthPercent;
    if (pending == null) {
      return;
    }
    this.pendingSidebarWidthPercent = null;
    void this.persistSidebarWidthPercentNow(pending);
  }

  private async persistSidebarWidthPercentNow(percent: number): Promise<void> {
    const config = this.appConfig();
    if (!config) {
      return;
    }
    const normalized = this.normalizeSidebarWidthPercent(percent);
    if (config.chatSidebarWidthPercent === normalized) {
      return;
    }
    try {
      await this.electron.saveConfig({
        ...config,
        chatSidebarWidthPercent: normalized,
      });
    } catch (err) {
      console.error('[App] persist chatSidebarWidthPercent failed', err);
    }
  }

  private hydrateChatWindowStateFromConfig(config: AppConfig): void {
    if (this.chatLayoutHydrated) {
      return;
    }
    const { collapsed, expanded } = resolveChatWindowState(config);
    this.chatCollapsed.set(collapsed);
    this.chatExpanded.set(expanded);
    this.chatLayoutHydrated = true;
  }

  private async persistChatWindowStateNow(): Promise<void> {
    const config = this.appConfig();
    if (!config || !this.chatLayoutHydrated) {
      return;
    }
    const collapsed = this.chatCollapsed();
    const expanded = this.chatExpanded();
    const current = resolveChatWindowState(config);
    if (current.collapsed === collapsed && current.expanded === expanded) {
      return;
    }
    try {
      const saved = await this.electron.saveConfig({
        ...config,
        chatSidebarCollapsed: collapsed,
        chatExpandedToMainPanel: expanded,
      });
      this.appConfig.set(saved);
    } catch (err) {
      console.error('[App] persist chat window state failed', err);
    }
  }

  async onReasoningEffortChange(change: LlmReasoningSettingChange): Promise<void> {
    const config = this.appConfig();
    if (!config) {
      return;
    }
    const current = resolveActiveLlmConnection(config);
    if (!current) {
      return;
    }
    const unchanged =
      change.field === 'thinkingMode'
        ? current.thinkingMode === change.value
        : (current.reasoningEffort || '') === change.value;
    if (unchanged) {
      return;
    }
    try {
      await this.electron.saveConfig({
        ...config,
        llmProviders: patchLlmModelProfile(config.llmProviders, config.activeLlmModelId, {
          [change.field]: change.value,
        }),
      });
    } catch (err) {
      console.error(`[App] persist ${change.field} failed`, err);
    }
  }

  private async loadConversationsForWorkspace(): Promise<void> {
    await this.conversationSession.loadConversationsForWorkspace(this.currentWorkspaceId());
  }

  async onMessageSent(text: string): Promise<void> {
    const convId = this.activeConversationId();
    if (!convId) return;
    const normalized = text.trim();
    const attachments = this.composerContextFiles();
    if ((!normalized && attachments.length === 0) || this.pendingIds().has(convId)) return;
    if (this.contextChatBlocked()) {
      return;
    }
    this.conversationSession.prepareForSend(convId);
    if (this.speechEnabled()) {
      await this.tts.beginAssistantSpeechTurn();
    }
    try {
      const structuredContent = await this.buildStructuredContent(normalized, attachments);
      this.clearChatContextFiles();
      const userMessageId = this.conversationSession.pushMessage(
        'user',
        normalized,
        undefined,
        undefined,
        undefined,
        undefined,
        structuredContent,
      );
      const workspaceId = this.conversationSession.getActiveConversation()?.workspaceId ?? this.currentWorkspaceId();
      const mode = this.composerMode();
      this.electron.sendMessage(
        convId,
        normalized,
        composerApplyMode(mode),
        composerApplyMode(mode) && this.autoApplyMode(),
        structuredContentForBackendRequest(structuredContent),
        workspaceId,
        composerModeForBackend(mode),
        this.speechEnabled(),
        this.appConfig()?.audioTranscription?.ttsProvider === 'openai-compatible'
          ? 'openai-compatible'
          : DEFAULT_TTS_PROVIDER,
        userMessageId,
      );
      this.conversationSession.markMessagesDirtyAndAutoSave();
    } catch (err) {
      console.error('[App] onMessageSent failed:', err);
      this.conversationSession.resetStreamUiOnSendFailure(convId);
    }
  }

  /**
   * Build OpenAI-style multimodal blocks for the staged attachments.
   * Images are embedded inline as base64 `image_url`; other files are referenced by workspace path
   * so the model can read them with `read_workspace_file`.
   */
  private async buildStructuredContent(
    text: string,
    attachments: readonly ChatContextFile[],
  ): Promise<ChatStructuredContentPart[] | undefined> {
    if (attachments.length === 0) {
      return undefined;
    }
    const root = this.currentWorkspacePath().trim();
    const blocks: ChatStructuredContentPart[] = [];
    if (text) {
      blocks.push({ type: 'text', text });
    }
    for (const file of attachments) {
      if (file.kind === 'image') {
        blocks.push({ type: 'text', text: formatAttachedImageText(file) });
        if (root) {
          const res = await this.electron.readWorkspaceImageBase64(root, file.relativePath);
          if (res.ok && res.dataUrl) {
            blocks.push({ type: 'image_url', image_url: { url: res.dataUrl } });
            continue;
          }
        }
        continue;
      }
      blocks.push({ type: 'text', text: formatAttachedFileText(file) });
    }
    return blocks.length > 0 ? blocks : undefined;
  }

  async onNewConversation(): Promise<void> {
    await this.conversationSession.onNewConversation(this.currentWorkspaceId());
  }

  onAbortRequested(): void {
    const convId = this.activeConversationId();
    if (!convId || !this.pendingIds().has(convId)) return;
    void this.electron.abortMessage(convId);
  }

  async onRestoreConversation(target: { userMessageId?: string; userMessageIndex: number }): Promise<void> {
    const convId = this.activeConversationId();
    if (!convId) {
      return;
    }
    const messages = this.messages();
    const keepThrough = resolveRestoreUserIndex(messages, target);
    if (keepThrough < 0) {
      return;
    }
    const invertIds = journalUserIdsToInvert(messages, keepThrough);
    const selected = messages[keepThrough];
    const fallbackId = (selected?.role === 'user' && selected.id) || `restore-${keepThrough}`;
    let journal: ConversationFileJournalEntry[] = [];
    try {
      journal = await this.electron.listConversationFileJournal(convId);
    } catch {
      journal = [];
    }
    const fromDb = journal.filter((e) => invertIds.has(e.userMessageId));
    const fromCards =
      fromDb.length === 0 ? fallbackJournalFromMessages(messages, keepThrough, fallbackId) : [];
    const preview = journalPreviewPaths(
      invertJournalEntries([...fromDb, ...fromCards], new Set([...invertIds, fallbackId])),
    );
    const choice = await this.themedConfirm.open(
      conversationRestorePrompt({ fileCount: preview.length, samplePaths: preview }),
    );
    if (choice !== 'confirm') {
      return;
    }
    if (this.pendingIds().has(convId)) {
      await this.electron.abortMessage(convId);
    }
    const result = await this.electron.restoreConversationTimeline({
      conversationId: convId,
      userMessageId: target.userMessageId,
      userMessageIndex: target.userMessageIndex,
    });
    if (!result.ok) {
      console.error('[App] restore conversation failed:', result.error);
      return;
    }
    const draft = selected?.role === 'user' ? selected.text : '';
    this.conversationSession.applyRestoredMessages(abandonStaleHitlMessages(result.messages));
    this.conversationSession.removePending(convId);
    this.conversationSession.updateConversationMeta(convId, { updatedAt: new Date().toISOString() });
    this.composerDraft.set(draft);
  }

  onSendResponse(text: string): void {
    void this.onMessageSent(text);
  }

  onDeleteReviewFinished(event: {
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'delete_confirm' &&
          m.payload.requestId === event.requestId &&
          (m.reviewStatus ?? 'pending') === 'pending'
        ) {
          copy[i] = {
            ...m,
            reviewStatus: event.status,
            reviewSummary: event.summary,
          };
          break;
        }
      }
      return copy;
    });
    this.conversationSession.markMessagesDirtyAndAutoSave();
  }

  onCopyReviewFinished(event: {
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'copy_confirm' &&
          m.payload.requestId === event.requestId &&
          (m.reviewStatus ?? 'pending') === 'pending'
        ) {
          copy[i] = {
            ...m,
            reviewStatus: event.status,
            reviewSummary: event.summary,
          };
          break;
        }
      }
      return copy;
    });
    this.conversationSession.markMessagesDirtyAndAutoSave();
  }

  onAcceptCommandFinished(event: {
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'accept_command' &&
          m.payload.requestId === event.requestId &&
          (m.reviewStatus ?? 'pending') === 'pending'
        ) {
          copy[i] = {
            ...m,
            reviewStatus: event.status,
            reviewSummary: event.summary,
          };
          break;
        }
      }
      return copy;
    });
    this.conversationSession.markMessagesDirtyAndAutoSave();
  }

  onPlanConfirmFinished(event: {
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'plan_confirm' &&
          m.payload.requestId === event.requestId &&
          (m.reviewStatus ?? 'pending') === 'pending'
        ) {
          copy[i] = {
            ...m,
            reviewStatus: event.status,
            reviewSummary: event.summary,
          };
          break;
        }
      }
      return copy;
    });
    this.conversationSession.markMessagesDirtyAndAutoSave();
    if (event.status === 'cancelled') {
      this.closeBuildPlanTab(this.activeConversationId());
      return;
    }
    // Plan approved → execution begins. Flip the composer to agent mode for the
    // execution phase and leave it there after completion (nothing flips it back).
    this.composerMode.set('agent');
  }

  onAgentQuestionFinished(event: {
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
  }): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'agent_question' &&
          m.payload.requestId === event.requestId &&
          (m.reviewStatus ?? 'pending') === 'pending'
        ) {
          copy[i] = {
            ...m,
            reviewStatus: event.status,
            reviewSummary: event.summary,
          };
          break;
        }
      }
      return copy;
    });
    this.conversationSession.markMessagesDirtyAndAutoSave();
  }

  onDiffReviewFinished(event: { relativePath: string; status: 'complete' | 'cancelled'; summary?: string }): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'diff' &&
          m.payload.relativePath === event.relativePath &&
          (m.reviewStatus ?? 'pending') === 'pending'
        ) {
          copy[i] = {
            ...m,
            reviewStatus: event.status,
            reviewSummary: event.summary,
          };
          break;
        }
      }
      return copy;
    });
    this.conversationSession.markMessagesDirtyAndAutoSave();
  }

  onStagedTransferBatchFinished(event: {
    requestId: string;
    status: 'complete' | 'cancelled';
    summary?: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
  }): void {
    this.applyStagedTransferBatchMessageUpdate(event.requestId, {
      reviewStatus: event.status,
      reviewSummary: event.summary,
      fileResolutions: event.fileResolutions,
    });
  }

  onStagedTransferBatchFileResolved(event: {
    requestId: string;
    fileResolutions: Record<string, 'pending' | 'approved' | 're_review'>;
  }): void {
    this.applyStagedTransferBatchMessageUpdate(event.requestId, {
      fileResolutions: event.fileResolutions,
    });
  }

  private mergedStagedTransferBatchResolutions(
    payload: StagedTransferBatchPayload,
    persisted: Record<string, 'pending' | 'approved' | 're_review'> | undefined,
  ): Record<string, 'pending' | 'approved' | 're_review'> {
    return {
      ...(persisted ?? {}),
      ...this.pendingDiffReview.batchSessionFor(payload).resolutions(),
    };
  }

  private applyStagedTransferBatchMessageUpdate(
    requestId: string,
    patch: {
      reviewStatus?: 'complete' | 'cancelled';
      reviewSummary?: string;
      fileResolutions?: Record<string, 'pending' | 'approved' | 're_review'>;
    },
  ): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'staged_transfer_batch' &&
          m.payload.requestId === requestId &&
          (m.reviewStatus ?? 'pending') === 'pending'
        ) {
          copy[i] = {
            ...m,
            ...(patch.reviewStatus !== undefined ? { reviewStatus: patch.reviewStatus } : {}),
            ...(patch.reviewSummary !== undefined ? { reviewSummary: patch.reviewSummary } : {}),
            ...(patch.fileResolutions !== undefined ? { fileResolutions: patch.fileResolutions } : {}),
          };
          break;
        }
      }
      return copy;
    });
    this.conversationSession.markMessagesDirtyAndAutoSave();
  }

  async onSelectConversation(id: string): Promise<void> {
    await this.conversationSession.onSelectConversation(id, this.currentWorkspaceId());
  }

  async onDeleteConversation(id: string): Promise<void> {
    const conv = this.conversations().find((c) => c.id === id);
    const convWorkspaceId = conv?.workspaceId ?? this.currentWorkspaceId();
    await this.electron.deleteConversation(id, convWorkspaceId);
    this.removeContextMetricsForConversation(id);
    const isActive = id === this.activeConversationId();
    const wsId = this.currentWorkspaceId();
    const list = await this.electron.getConversations(wsId);
    this.conversations.set(list);

    if (isActive) {
      this.conversationSession.clearActiveConversationAfterDelete();
      if (list.length > 0) {
        const nextConv = list[0];
        await this.conversationSession.loadConversation(nextConv.id, nextConv.workspaceId ?? wsId);
      } else {
        await this.onNewConversation();
      }
    }
  }

  async onRenameConversation(event: { id: string; title: string }): Promise<void> {
    const conv = this.conversations().find((c) => c.id === event.id);
    const convWorkspaceId = conv?.workspaceId ?? this.currentWorkspaceId();
    await this.electron.renameConversation(event.id, event.title, convWorkspaceId);
    this.conversationSession.patchActiveConversationTitle(event.id, event.title);
    this.conversationSession.updateConversationMeta(event.id, {
      title: event.title,
      updatedAt: new Date().toISOString(),
      customTitle: true,
    });
  }

  onWorkspaceResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.resizing = 'workspace';
    document.body.classList.add('workspace-resizing');
    this.zone.runOutsideAngular(() => {
      window.addEventListener('mousemove', this.boundOnResizeMove);
      window.addEventListener('mouseup', this.boundOnResizeEnd);
    });
  }

  onSidebarResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.resizing = 'sidebar';
    document.body.classList.add('sidebar-resizing');
    this.zone.runOutsideAngular(() => {
      window.addEventListener('mousemove', this.boundOnResizeMove);
      window.addEventListener('mouseup', this.boundOnResizeEnd);
    });
  }

  private onResizeMove(event: MouseEvent): void {
    if (!this.resizing) return;

    if (this.resizing === 'workspace') {
      const newWidth = event.clientX;
      const clamped = Math.min(App.MAX_WORKSPACE, Math.max(App.MIN_WORKSPACE, newWidth));
      this.zone.run(() => this.workspaceWidth.set(clamped));
    } else if (this.resizing === 'sidebar') {
      const newWidth = window.innerWidth - event.clientX;
      const clamped = Math.min(App.MAX_SIDEBAR, Math.max(App.MIN_SIDEBAR, newWidth));
      this.zone.run(() => this.sidebarWidth.set(clamped));
    }
  }

  private onResizeEnd(): void {
    const resizing = this.resizing;
    const sidebarPx = this.sidebarWidth();
    this.resizing = null;
    document.body.classList.remove('workspace-resizing');
    document.body.classList.remove('sidebar-resizing');
    window.removeEventListener('mousemove', this.boundOnResizeMove);
    window.removeEventListener('mouseup', this.boundOnResizeEnd);

    if (resizing === 'sidebar') {
      this.scheduleSidebarWidthPersist(this.percentFromSidebarPixels(sidebarPx));
      return;
    }

    if (resizing === 'workspace') {
      this.syncSidebarWidthFromEffectivePercent();
    }
  }

  // Workspace management
  async onWorkspaceChanged(workspaceId: string | null): Promise<void> {
    console.log('[App] onWorkspaceChanged:', workspaceId);
    if (workspaceId === this.currentWorkspaceId()) {
      return;
    }
    // Save current conversation before switching
    await this.conversationSession.saveCurrentConversation();

    const canLeave = await this.prepareWorkspaceLeave(this.currentWorkspaceId());
    if (!canLeave) {
      return;
    }

    await this.electron.setCurrentWorkspace(workspaceId);
    this.currentWorkspaceId.set(workspaceId);
    // Refresh config to get updated workspaces
    const config = await this.electron.loadConfig();
    this.workspaces.set(config.workspaces);

    // Load conversations for the new workspace
    await this.loadConversationsForWorkspace();
  }

  async onAddWorkspace(): Promise<void> {
    const selected = await this.electron.openDirectoryDialog();
    if (selected) {
      const existing = this.workspaces().find((workspace) => workspace.path === selected);
      if (existing) {
        await this.onWorkspaceChanged(existing.id);
        return;
      }
      const name = selected.split(/[\\/]/).pop() || 'New Workspace';
      await this.electron.addWorkspace(name, selected);
      const config = await this.electron.loadConfig();
      this.workspaces.set(config.workspaces);
      // Auto-select the new workspace
      await this.onWorkspaceChanged(config.workspaces[config.workspaces.length - 1].id);
    }
  }

  protected openOrFocusFileTab(relativePath: string): void {
    const root = this.currentWorkspacePath().trim();
    if (!root) {
      return;
    }
    const norm = normalizePathSlashes(relativePath);
    if (!norm) {
      return;
    }

    // Same-folder images share one gallery tab (swap path) instead of stacking tabs.
    const imagePlan = planOpenWorkspaceImageTab(this.fileTabs(), norm, this.activeMainTabId());
    if (imagePlan?.action === 'focus') {
      this.activeMainTabId.set(imagePlan.tabId);
      this.chatExpanded.set(false);
      return;
    }
    if (imagePlan?.action === 'retarget') {
      this.fileTabs.update((tabs) =>
        retargetFileTabPath(tabs, imagePlan.oldRelativePath, imagePlan.newRelativePath),
      );
      this.activeMainTabId.set(
        chatFileTabId({ relativePath: imagePlan.newRelativePath, outsideWorkspace: false }),
      );
      this.chatExpanded.set(false);
      return;
    }

    const tab = workspaceChatFileTab(norm);
    const id = chatFileTabId(tab);
    const tabs = this.fileTabs();
    if (!tabs.some((t) => chatFileTabModelKey(t) === chatFileTabModelKey(tab))) {
      this.fileTabs.update((ts) => [...ts, tab]);
    }
    this.activeMainTabId.set(id);
    // Opening a file in the workspace Monaco editor collapses the expanded chat
    // overlay so the editor is actually visible.
    this.chatExpanded.set(false);
  }

  protected openOrFocusBuildPlanTab(relativePath: string, planId: string, active: boolean): void {
    const root = this.currentWorkspacePath().trim();
    if (!root) {
      return;
    }
    const norm = normalizePathSlashes(relativePath);
    if (!norm || !planId.trim()) {
      return;
    }
    const tabs = this.fileTabs();
    const byPlanIdx = tabs.findIndex((t) => t.buildPlanId === planId);
    if (byPlanIdx >= 0) {
      const updated = [...tabs];
      updated[byPlanIdx] = {
        ...updated[byPlanIdx]!,
        relativePath: norm,
        buildPlanActive: active,
        previewOnly: true,
      };
      this.fileTabs.set(updated);
      this.activeMainTabId.set(chatFileTabId(updated[byPlanIdx]!));
      return;
    }
    const byPathIdx = tabs.findIndex(
      (t) => !t.outsideWorkspace && normalizePathSlashes(t.relativePath ?? '') === norm,
    );
    if (byPathIdx >= 0) {
      const updated = [...tabs];
      updated[byPathIdx] = {
        ...updated[byPathIdx]!,
        buildPlanId: planId,
        buildPlanActive: active,
        previewOnly: true,
      };
      this.fileTabs.set(updated);
      this.activeMainTabId.set(chatFileTabId(updated[byPathIdx]!));
      return;
    }
    const tab = buildPlanChatFileTab(norm, planId, active);
    this.fileTabs.update((ts) => [...ts, tab]);
    this.activeMainTabId.set(chatFileTabId(tab));
  }

  private setBuildPlanTabInactive(conversationId: string, planId?: string): void {
    const tracked = this.activeBuildPlanByConversation.get(conversationId);
    const id = planId ?? tracked?.planId;
    if (!id) {
      return;
    }
    if (tracked) {
      this.activeBuildPlanByConversation.set(conversationId, { ...tracked, active: false });
    }
    this.fileTabs.update((tabs) => deactivateBuildPlanTab(tabs, id));
  }

  private closeBuildPlanTab(conversationId: string | null, planId?: string): void {
    if (!conversationId) {
      return;
    }
    const tracked = this.activeBuildPlanByConversation.get(conversationId);
    const id = planId ?? tracked?.planId;
    if (!id) {
      return;
    }
    this.activeBuildPlanByConversation.delete(conversationId);
    const tabToClose = this.fileTabs().find((t) => t.buildPlanId === id);
    const closingTabId = tabToClose ? chatFileTabId(tabToClose) : null;
    const remaining = removeBuildPlanTab(this.fileTabs(), id);
    if (closingTabId && this.activeMainTabId() === closingTabId) {
      if (remaining.length > 0) {
        this.activeMainTabId.set(chatFileTabId(remaining[remaining.length - 1]!));
      } else {
        this.activeMainTabId.set(null);
      }
    }
    this.fileTabs.set(remaining);
  }

  private closeFileTabContextMenu(): void {
    this.fileTabContextMenuVisible.set(false);
    this.fileTabContextMenuTabId.set(null);
  }

  private closeChromeMenu(): void {
    this.chromeMenu.set(null);
  }

  private openChromeMenu(kind: 'settings', ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.closeFileTabContextMenu();
    if (this.chromeMenu() === kind) {
      this.closeChromeMenu();
      return;
    }
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    this.chromeMenuX.set(Math.floor(r.left));
    this.chromeMenuY.set(Math.floor(r.bottom) + 2);
    this.chromeMenu.set(kind);
  }

  protected onChromeSettingsMenu(ev: MouseEvent): void {
    this.openChromeMenu('settings', ev);
  }

  protected onChromeMenuItemMousedown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  protected onChromeMenuSettingsTab(tab: SettingsTab): void {
    this.closeChromeMenu();
    this.electron.openSettingsWindow(tab);
  }

  protected onChromeDependencies(): void {
    this.closeChromeMenu();
    this.electron.openDependenciesWindow();
  }

  protected onChromeHealth(): void {
    this.closeChromeMenu();
    this.electron.openHealthWindow();
  }

  private async tryCloseFileTabById(tabId: string): Promise<boolean> {
    if (!tabId.startsWith('file:')) {
      return false;
    }
    return this.tryCloseFileTabByModelKey(tabId.slice(5));
  }

  private async tryCloseFileTabByModelKey(modelKey: string): Promise<boolean> {
    let keyToClose = modelKey;
    const tab = findTabByModelKey(this.fileTabs(), modelKey);
    const displayPath =
      relativePathFromModelKey(modelKey) ??
      (tab ? chatFileTabBasename(tab) : modelKey);
    const detached = this.monacoDetachedPaths().has(modelKey);
    const unsaved = this.fileTabIsUnsaved(modelKey);

    if (tab?.buildPlanId && tab.buildPlanActive) {
      const choice = await this.themedConfirm.open(activeBuildPlanClosePrompt(displayPath));
      if (choice !== 'confirm') {
        return false;
      }
      const convId = this.activeConversationId();
      if (convId) {
        await this.electron.cancelBuildPlan(convId, tab.buildPlanId);
        void this.electron.abortMessage(convId);
        this.activeBuildPlanByConversation.delete(convId);
      }
      this.removeFileTabByModelKey(keyToClose);
      return true;
    }

    if (detached && unsaved) {
      const choice = await this.themedConfirm.open(detachedFileClosePrompt(displayPath));
      if (choice === 'cancel') {
        return false;
      }
      if (choice === 'middle') {
        const newKey = await this.workspaceMonaco?.saveAsForKey(modelKey);
        if (!newKey) {
          return false;
        }
        keyToClose = newKey;
      } else if (choice === 'confirm') {
        await this.workspaceMonaco?.cleanupDetachedForKey(modelKey);
      }
    } else if (unsaved) {
      const discard = await this.themedConfirm.open(unsavedCloseFileTabPrompt(displayPath));
      if (discard !== 'confirm') {
        return false;
      }
    } else if (detached) {
      await this.workspaceMonaco?.cleanupDetachedForKey(modelKey);
    }

    this.removeFileTabByModelKey(keyToClose);
    return true;
  }

  private async closeFileTabsInOrder(tabIds: readonly string[]): Promise<void> {
    for (const tabId of tabIds) {
      const closed = await this.tryCloseFileTabById(tabId);
      if (!closed) {
        break;
      }
    }
  }

  private removeFileTabByModelKey(keyToClose: string): void {
    const remaining = this.fileTabs().filter((t) => chatFileTabModelKey(t) !== keyToClose);
    const tabId = `file:${keyToClose}`;
    if (this.activeMainTabId() === tabId) {
      if (remaining.length > 0) {
        const last = remaining[remaining.length - 1]!;
        this.activeMainTabId.set(chatFileTabId(last));
      } else {
        this.activeMainTabId.set(null);
      }
    }
    this.fileTabs.set(remaining);
  }

  private applyFileRenamedTabs(oldRelativePath: string, newRelativePath: string): void {
    const { tabs, focusTabId } = openTabForRenamedFile(
      this.fileTabs(),
      oldRelativePath,
      newRelativePath,
    );
    if (focusTabId) {
      this.fileTabs.set(tabs);
      this.activeMainTabId.set(focusTabId);
    }
  }

  private async onWorkspaceFilesChangedForEditorTabs(event: WorkspaceFilesChangedMessage): Promise<void> {
    const workspaceId = this.currentWorkspaceId();
    const root = this.currentWorkspacePath().trim();
    if (!workspaceId || !root || event.workspaceId !== workspaceId) {
      return;
    }

    for (let i = 0; i < event.paths.length; i++) {
      if (event.kinds[i] !== 'renamed') {
        continue;
      }
      const newRel = normalizePathSlashes(event.paths[i] ?? '');
      if (!newRel || newRel === '.') {
        continue;
      }
      const previous = event.previousPaths?.[i];
      if (previous?.trim()) {
        const oldRel = normalizePathSlashes(previous);
        if (oldRel && oldRel !== '.' && oldRel !== newRel) {
          this.applyFileRenamedTabs(oldRel, newRel);
        }
        continue;
      }
      await this.inferAndApplyFileRename(root, newRel);
    }
  }

  private async inferAndApplyFileRename(workspaceRoot: string, newRelativePath: string): Promise<void> {
    const newNorm = normalizePathSlashes(newRelativePath);
    const newParent = parentRelativePath(newNorm);

    for (const tab of this.fileTabs()) {
      if (tab.outsideWorkspace || !tab.relativePath?.trim()) {
        continue;
      }
      const oldNorm = normalizePathSlashes(tab.relativePath);
      if (oldNorm === newNorm || parentRelativePath(oldNorm) !== newParent) {
        continue;
      }
      const exists = await this.electron.workspaceFileExists(workspaceRoot, oldNorm);
      if (!exists.ok || exists.exists) {
        continue;
      }
      this.applyFileRenamedTabs(oldNorm, newNorm);
      return;
    }
  }

  protected onMonacoSaveAsCompleted(payload: {
    oldModelKey: string;
    relativePath?: string;
    absolutePath?: string;
    outsideWorkspace: boolean;
  }): void {
    const oldKey = payload.oldModelKey;
    this.fileTabs.update((tabs) =>
      replaceFileTabAfterSaveAs(tabs, oldKey, {
        relativePath: payload.relativePath,
        absolutePath: payload.absolutePath,
        outsideWorkspace: payload.outsideWorkspace,
      }),
    );
    const updated = this.fileTabs().find((t) => {
      if (payload.outsideWorkspace && payload.absolutePath) {
        return t.absolutePath === payload.absolutePath;
      }
      if (payload.relativePath) {
        return (
          !t.outsideWorkspace &&
          normalizePathSlashes(t.relativePath ?? '') === normalizePathSlashes(payload.relativePath)
        );
      }
      return false;
    });
    if (updated && this.activeMainTabId() === `file:${oldKey}`) {
      this.activeMainTabId.set(chatFileTabId(updated));
    }
  }

  protected onMonacoDetachedPathsChange(paths: readonly string[]): void {
    this.monacoDetachedPaths.set(new Set(paths));
  }

  protected onWorkspaceMonacoNavigate(payload: { relativePath: string; line: number; column: number }): void {
    this.openOrFocusFileTab(payload.relativePath);
    this.monacoRevealPending.set({
      relativePath: normalizePathSlashes(payload.relativePath),
      line: payload.line,
      column: payload.column,
    });
  }

  protected onMonacoOutlineChange(payload: {
    relativePath: string | null;
    symbols: readonly EditorOutlineSymbol[];
  }): void {
    this.monacoOutlineState.set({
      relativePath: payload.relativePath,
      symbols: payload.symbols,
    });
  }

  protected onMonacoDiagnosticsChange(payload: {
    relativePath: string | null;
    diagnostics: readonly LspEditorDiagnostic[];
  }): void {
    this.monacoDiagnosticsState.set({
      relativePath: payload.relativePath,
      diagnostics: payload.diagnostics,
    });
  }

  protected onRevealEditorDiagnostic(d: LspEditorDiagnostic): void {
    this.workspaceMonaco?.revealDiagnostic(d);
  }

  protected onImageViewerNavigate(payload: { relativePath: string }): void {
    const newPath = normalizePathSlashes(payload.relativePath);
    if (!newPath) {
      return;
    }
    const oldPath = this.activeFileRelativePath();
    if (!oldPath || normalizePathSlashes(oldPath) === newPath) {
      return;
    }
    // Never let gallery navigation retarget a non-image (e.g. source file) tab.
    if (!isViewableImagePath(oldPath)) {
      return;
    }
    this.fileTabs.update((tabs) => retargetFileTabPath(tabs, oldPath, newPath));
    this.activeMainTabId.set(chatFileTabId({ relativePath: newPath, outsideWorkspace: false }));
  }

  protected onMonacoRevealHandled(): void {
    this.monacoRevealPending.set(null);
  }

  protected selectMainTab(tabId: string): void {
    this.activeMainTabId.set(tabId);
    if (tabId.startsWith('file:')) {
      // Focusing an editor file tab collapses the expanded chat overlay so the
      // selected file is actually visible.
      this.chatExpanded.set(false);
    }
  }

  protected onFileTabDrop(event: CdkDragDrop<ChatFileTab[]>): void {
    if (event.previousIndex === event.currentIndex) {
      return;
    }
    this.fileTabs.update((tabs) => reorderFileTabs(tabs, event.previousIndex, event.currentIndex));
  }

  protected async closeMainFileTab(event: MouseEvent, tabId: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.tryCloseFileTabById(tabId);
  }

  protected onFileTabContextMenu(event: MouseEvent, tabId: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeChromeMenu();
    this.fileTabContextMenuTabId.set(tabId);
    this.fileTabContextMenuX.set(event.clientX);
    this.fileTabContextMenuY.set(event.clientY);
    this.fileTabContextMenuVisible.set(true);
  }

  protected onFileTabContextMenuItemMousedown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  protected async onFileTabContextMenuClose(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    this.closeFileTabContextMenu();
    if (tabId) {
      await this.tryCloseFileTabById(tabId);
    }
  }

  protected async onFileTabContextMenuCloseAll(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    this.closeFileTabContextMenu();
    if (!tabId) {
      return;
    }
    const tabIds = [...allFileTabIds(this.fileTabs())].reverse();
    await this.closeFileTabsInOrder(tabIds);
  }

  protected async onFileTabContextMenuCloseLeft(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    this.closeFileTabContextMenu();
    if (!tabId) {
      return;
    }
    const tabIds = [...fileTabIdsToLeft(this.fileTabs(), tabId)].reverse();
    await this.closeFileTabsInOrder(tabIds);
  }

  protected async onFileTabContextMenuCloseRight(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    this.closeFileTabContextMenu();
    if (!tabId) {
      return;
    }
    const tabIds = [...fileTabIdsToRight(this.fileTabs(), tabId)].reverse();
    await this.closeFileTabsInOrder(tabIds);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    const path = ev.composedPath();
    if (this.fileTabContextMenuVisible()) {
      const insideFileTab = path.some(
        (n) => n instanceof HTMLElement && n.classList.contains('file-tab-context-menu'),
      );
      if (!insideFileTab) {
        this.closeFileTabContextMenu();
      }
    }
    if (this.chromeMenu()) {
      const insideChrome = path.some(
        (n) =>
          n instanceof HTMLElement &&
          (n.classList.contains('chrome-dropdown-menu') || n.classList.contains('chrome-menu-btn')),
      );
      if (!insideChrome) {
        this.closeChromeMenu();
      }
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeCloseMenus(): void {
    if (this.fileTabContextMenuVisible()) {
      this.closeFileTabContextMenu();
    }
    if (this.chromeMenu()) {
      this.closeChromeMenu();
    }
  }

  /** Main stole Ctrl/Cmd+F from Chromium — open Monaco find when a file editor is on stage. */
  private onEditorFindRequested(): void {
    const tabId = this.activeMainTabId();
    if (!tabId?.startsWith('file:') || this.activeFileIsImage() || this.chatExpanded()) {
      return;
    }
    this.workspaceMonaco?.openFindWidget();
  }

  protected onWorkspaceFileOpen(payload: { absolutePath: string }): void {
    const root = this.currentWorkspacePath().trim();
    if (!root) {
      return;
    }
    const rel = workspaceRelativePathIfUnderRoot(root, payload.absolutePath);
    if (rel === null || rel === '') {
      return;
    }
    this.openOrFocusFileTab(rel);
  }

  /** Add a file or folder (from the tree context menu or a drop) to the chat reference bar. */
  protected async addChatContextPath(absolutePath: string, isDirectory?: boolean): Promise<void> {
    const root = this.currentWorkspacePath().trim();
    if (!root) {
      return;
    }
    const relRaw = workspaceRelativePathIfUnderRoot(root, absolutePath);
    if (relRaw === null) {
      return;
    }
    let isDir = isDirectory;
    if (isDir === undefined) {
      isDir = await this.electron.workspacePathIsDirectory(absolutePath);
    }
    const relativePath = relRaw === '' ? '.' : relRaw;
    const name =
      relativePath === '.'
        ? (normalizePathSlashes(root).split('/').filter(Boolean).pop() ?? 'workspace')
        : (relativePath.split('/').filter(Boolean).pop() ?? relativePath);
    let kind: ChatContextFile['kind'];
    if (isDir) {
      kind = 'folder';
    } else if (isImagePath(relativePath)) {
      kind = 'image';
    } else {
      kind = 'file';
    }
    const entry: ChatContextFile = {
      absolutePath,
      relativePath,
      name,
      kind,
      source: 'tree',
    };
    this.chatContextFiles.update((files) => {
      if (files.some((f) => chatContextFileKey(f) === chatContextFileKey(entry))) {
        return files;
      }
      return [...files, entry];
    });
  }

  /** @deprecated Use {@link addChatContextPath}. */
  protected addChatContextFile(absolutePath: string): void {
    void this.addChatContextPath(absolutePath);
  }

  protected onEditorSelectionChange(payload: EditorSelectionPayload | null): void {
    if (!payload) {
      this.editorSelectionChip.set(null);
      return;
    }
    const chip = chatContextFileFromEditorSelection(payload, false);
    const pinned = this.chatContextFiles();
    if (pinned.some((f) => chatContextFilesEqual(f, chip))) {
      this.editorSelectionChip.set(null);
      return;
    }
    this.editorSelectionChip.set(chip);
  }

  protected onTogglePinChatContextFile(file: ChatContextFile): void {
    if (file.source !== 'editor' || !file.lineRange) {
      return;
    }
    const key = chatContextFileKey(file);
    const ephemeral = this.editorSelectionChip();
    if (ephemeral && chatContextFileKey(ephemeral) === key && !file.pinned) {
      this.chatContextFiles.update((files) => {
        if (files.some((f) => chatContextFileKey(f) === key)) {
          return files;
        }
        return [...files, { ...ephemeral, pinned: true }];
      });
      this.editorSelectionChip.set(null);
      return;
    }
    if (file.pinned) {
      this.chatContextFiles.update((files) =>
        files.filter((f) => chatContextFileKey(f) !== key),
      );
      return;
    }
    this.chatContextFiles.update((files) =>
      files.map((f) => (chatContextFileKey(f) === key ? { ...f, pinned: true } : f)),
    );
  }

  protected onChatContextPathsDropped(dropped: readonly ChatContextDroppedPath[]): void {
    for (const { absolutePath, isDirectory } of dropped) {
      void this.addChatContextPath(absolutePath, isDirectory);
    }
  }

  protected removeChatContextFile(file: ChatContextFile): void {
    const key = chatContextFileKey(file);
    const ephemeral = this.editorSelectionChip();
    if (ephemeral && chatContextFileKey(ephemeral) === key) {
      this.editorSelectionChip.set(null);
      return;
    }
    this.chatContextFiles.update((files) => files.filter((f) => chatContextFileKey(f) !== key));
  }

  protected clearChatContextFiles(): void {
    this.chatContextFiles.set([]);
    this.editorSelectionChip.set(null);
  }

  protected fileTabIdForTab(tab: ChatFileTab): string {
    return chatFileTabId(tab);
  }

  protected chatFileTabModelKey(tab: ChatFileTab): string {
    return chatFileTabModelKey(tab);
  }

  protected fileTabBasenameForTab(tab: ChatFileTab): string {
    return chatFileTabBasename(tab);
  }

  protected fileTabIsUnsaved(modelKey: string): boolean {
    return this.monacoUnsavedPaths().has(modelKey);
  }

  protected fileTabIsDetached(modelKey: string): boolean {
    return this.monacoDetachedPaths().has(modelKey);
  }

  protected fileTabTitle(tab: ChatFileTab): string | null {
    const key = chatFileTabModelKey(tab);
    if (tab.outsideWorkspace) {
      return 'This file is outside of the workspace.';
    }
    if (this.fileTabIsDetached(key)) {
      return 'This file no longer exists at this path — save to choose a location.';
    }
    return null;
  }

  protected onMonacoUnsavedPathsChange(paths: readonly string[]): void {
    const next = new Set(paths);
    this.monacoUnsavedPaths.set(next);
    this.electron.reportWorkspaceMonacoUnsavedPaths(
      [...next].map((k) => relativePathFromModelKey(k) ?? k),
    );
  }

  private async syncWorkspaceContext(workspacePath: string): Promise<void> {
    const convId = this.activeConversationId();
    if (!convId || !workspacePath) return;

    const syncToken = ++this.workspaceSyncToken;

    try {
      const tree = await this.electron.readDirectoryRecursive(workspacePath);
      if (syncToken !== this.workspaceSyncToken || convId !== this.activeConversationId()) {
        return;
      }
      this.workspaceContextText.set(tree);
      const ws = this.currentWorkspace();
      const pyId = (ws?.pythonInterpreterId ?? '').trim();
      await this.electron.setWorkspaceContext(convId, workspacePath, tree, {
        workspaceId: this.currentWorkspaceId() ?? '',
        ...(pyId ? { pythonInterpreterId: pyId } : {}),
      });
    } catch (err) {
      console.error('[App] Failed to sync workspace context:', err);
    }
  }

  /** Unsaved-file and active-stream guards; aborts streams on confirm. Returns false to cancel leave. */
  private async prepareWorkspaceLeave(fromWorkspaceId: string | null): Promise<boolean> {
    const unsaved = [...this.monacoUnsavedPaths()];
    if (unsaved.length > 0) {
      const proceed = (await this.themedConfirm.open(unsavedWorkspaceSwitchPrompt(unsaved))) === 'confirm';
      if (!proceed) {
        return false;
      }
    }

    const pending = this.conversationSession.getPendingStreamIdsForWorkspace(fromWorkspaceId);
    if (pending.length > 0) {
      const proceed = (await this.themedConfirm.open(activeStreamWorkspaceSwitchPrompt(pending.length))) === 'confirm';
      if (!proceed) {
        return false;
      }
      await this.conversationSession.abortPendingStreamsForWorkspace(fromWorkspaceId);
    }

    return true;
  }

  protected toggleVoice(): void {
    const on = this.talkEnabled() && this.speechEnabled();
    const next = !on;
    this.talkEnabled.set(next);
    this.speechEnabled.set(next);
  }

  protected onTalkRecordingBegan(): void {
    this.tts.onTalkRecordingBegan(this.talkEnabled(), this.speechEnabled());
  }

  protected onTalkCaptureFinished(event: { hadSpeech: boolean; userBargeIn: boolean }): void {
    this.tts.onTalkCaptureFinished(event, this.talkEnabled());
  }

  private async handleOpenWorkspace(workspacePath: string): Promise<void> {
    const normalizedPath = workspacePath.trim();
    if (!normalizedPath) return;

    const existing = this.workspaces().find((workspace) => workspace.path === normalizedPath);
    if (existing) {
      await this.onWorkspaceChanged(existing.id);
      return;
    }

    const name = normalizedPath.split(/[\\/]/).pop() || 'Workspace';
    await this.electron.addWorkspace(name, normalizedPath);
    const config = await this.electron.loadConfig();
    this.workspaces.set(config.workspaces);
    const added = config.workspaces.find((workspace) => workspace.path === normalizedPath);
    if (added) {
      await this.onWorkspaceChanged(added.id);
    }
  }

  private async handleOpenConversation(conversationId: string): Promise<void> {
    const targetId = conversationId.trim();
    if (!targetId) return;

    if (this.activeConversationId() === targetId) {
      return;
    }

    await this.conversationSession.saveCurrentConversation();
    const skipTargetPython = this.pendingIds().has(targetId);
    const conv = await this.electron.readConversationFromDisk(targetId);

    if (conv.workspaceId !== this.currentWorkspaceId()) {
      const canLeave = await this.prepareWorkspaceLeave(this.currentWorkspaceId());
      if (!canLeave) {
        return;
      }
      await this.electron.setCurrentWorkspace(conv.workspaceId);
      const config = await this.electron.loadConfig();
      this.workspaces.set(config.workspaces);
      this.currentWorkspaceId.set(config.currentWorkspaceId);
      const list = await this.electron.getConversations(conv.workspaceId);
      this.conversations.set(list);
    }

    await this.conversationSession.loadConversation(conv.id, conv.workspaceId, { skipPythonResync: skipTargetPython });
    this.chatHubView.set('activeChat');
  }

  protected onWindowMinimize(): void {
    this.electron.windowMinimize();
  }

  protected togglePinned(): void {
    this.pinned.set(!this.pinned());
  }

  protected onWindowToggleMaximize(): void {
    this.electron.windowToggleMaximize();
  }

  protected onWindowClose(): void {
    this.electron.windowClose();
  }

  private currentTranscriptFallbackTokens(): number {
    return estimateTranscriptContextTokens({
      messages: this.messages(),
      streamingParts: this.streamingParts(),
      workspaceContextText: this.workspaceContextText(),
    });
  }

  private setMeasuredPromptTokensForConversation(conversationId: string, tokens: number): void {
    if (!conversationId || tokens <= 0) {
      return;
    }
    this.measuredPromptTokensByConversation.update((prev) => ({
      ...prev,
      [conversationId]: Math.floor(tokens),
    }));
    if (conversationId === this.activeConversationId()) {
      const baseline = this.currentTranscriptFallbackTokens();
      this.measuredBaselineFallbackByConversation.update((prev) => ({
        ...prev,
        [conversationId]: baseline,
      }));
      return;
    }
    // Background conversation: only the active transcript signals are live here, so keep the
    // meter at the absolute measurement until this conversation is focused and remeasured.
    this.measuredBaselineFallbackByConversation.update((prev) => {
      if (!(conversationId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
  }

  private removeContextMetricsForConversation(conversationId: string): void {
    if (!conversationId) {
      return;
    }
    this.measuredPromptTokensByConversation.update((prev) => {
      if (!(conversationId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
    this.measuredBaselineFallbackByConversation.update((prev) => {
      if (!(conversationId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
  }
}
