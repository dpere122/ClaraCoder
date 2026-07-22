/**
 * Main chat shell: conversations, workspace chrome, IPC-driven streaming, and layout resize handles.
 * TTS playback lives in {@link TtsPlaybackService}; this component wires signals and `ElectronService` streams.
 */
import { Component, computed, effect, model, NgZone, OnDestroy, OnInit, signal, untracked, ViewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  ChatStructuredContentPart,
  ComposerRunMode,
  Conversation,
  ConversationMeta,
  FileDiffPayload,
  LlmStatus,
  StreamPart,
  StagedTransferBatchPayload,
  Workspace,
  WorkspaceFilesChangedMessage,
  PlannerProgress,
} from '@shared/index';
import {
  DEFAULT_COMPOSER_RUN_MODE,
  DEFAULT_KOKORO_TTS_VOICE,
  primaryAssistantTextFromParts,
  appendAndMergeReadToolPreviewChunk,
  findReadToolTrailTargetIndex,
  toolTrailStatusIdFromStreamTag,
  toolTrailStatusStreamTag,
  resolveActiveLlmConnection,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
} from '@shared/index';
import { ChatActiveStackComponent } from '../chat/chat-active-stack/chat-active-stack';
import { ChatConversationHubComponent, type ChatHubView } from '../chat/chat-conversation-hub/chat-conversation-hub';
import { type ChatMessage } from '../chat/chat-box/chat-box';
import {
  type ChatContextFile,
  chatContextFileFromEditorSelection,
  chatContextFileKey,
  chatContextFilesEqual,
  formatAttachedFileText,
  isImagePath,
  type EditorSelectionPayload,
} from '../chat/chat-context-bar/chat-context-file';
import type { ChatContextDroppedPath } from '../chat/chat-context-bar/chat-context-drop';
import { buildAssistantTurnFromStreamParts } from './app-assistant-turn';
import {
  chatFileTabBasename,
  chatFileTabId,
  chatFileTabModelKey,
  deactivateBuildPlanTab,
  findTabByModelKey,
  openEditorFileRefFromTab,
  openTabForRenamedFile,
  removeBuildPlanTab,
  replaceFileTabAfterSaveAs,
  type ChatFileTab,
  workspaceChatFileTab,
  buildPlanChatFileTab,
} from './app-chat-file-tabs';
import { relativePathFromModelKey } from '../workspace/open-editor-file-ref';
import {
  appendStreamPart,
  markToolExecStreamComplete,
  upsertToolTrailStatusStreamPart,
} from './app-stream-parts';
import { applyAppFontOverrides, applyAppTheme, resolveAppThemeId } from './app-theme';
import { buildContextCapacitySnapshot, CONTEXT_CHAT_BLOCKED_PERCENT } from '../status/context-capacity/context-capacity.utils';
import { MainPanelEmptyStateComponent } from './main-panel-empty-state/main-panel-empty-state';
import { WorkspaceComponent } from '../workspace/workspace/workspace';
import { WorkspaceMonacoComponent } from '../workspace/workspace-monaco/workspace-monaco';
import { editorModelKeyForRelativePath } from '../workspace/open-editor-file-ref';
import { ImageViewerComponent } from '../workspace/image-viewer/image-viewer';
import { isViewableImagePath } from '../workspace/image-viewer/image-viewer-formats';
import { WorkspaceTerminalDockComponent } from '../workspace-terminal/workspace-terminal-dock';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { ThemedConfirmDialogService } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { PendingDiffReviewService } from '../diff/pending-diff-review.service';
import { ThemedConfirmDialogComponent } from '../../shared/themed-confirm-dialog/themed-confirm-dialog';
import {
  activeStreamWorkspaceSwitchPrompt,
  unsavedCloseFileTabPrompt,
  unsavedWorkspaceSwitchPrompt,
  detachedFileClosePrompt,
  activeBuildPlanClosePrompt,
} from '../../shared/themed-confirm-dialog/format-unsaved-workspace-detail';
import { normalizePathSlashes, workspaceRelativePathIfUnderRoot } from '../../utils/workspace-relative-path';
import { LucideAngularModule } from 'lucide-angular';

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
    MainPanelEmptyStateComponent,
    LucideAngularModule,
    WorkspaceComponent,
    WorkspaceMonacoComponent,
    ImageViewerComponent,
    WorkspaceTerminalDockComponent,
    ThemedConfirmDialogComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  @ViewChild(WorkspaceMonacoComponent) private workspaceMonaco?: WorkspaceMonacoComponent;
  protected readonly appConfig = signal<AppConfig | null>(null);
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly pinned = model(false);
  protected readonly pendingIds = signal<Set<string>>(new Set());
  protected readonly loading = computed(() => {
    const id = this.activeConversationId();
    return id != null && this.pendingIds().has(id);
  });
  protected readonly conversations = signal<ConversationMeta[]>([]);
  protected readonly activeConversationId = signal<string | null>(null);
  protected readonly fontSize = model(0.9);
  protected readonly speechEnabled = model(false);
  protected readonly selectedVoice = model(DEFAULT_KOKORO_TTS_VOICE);
  protected readonly ttsSpeechSpeed = signal(TTS_SPEECH_SPEED_DEFAULT);
  protected readonly talkStatus = model('');
  /** Errors / hints from talk capture (shown in composer status row). */
  protected readonly talkModeDetailStatus = model('');
  protected readonly talkEnabled = model(false);
  /**
   * Editor mode: when true, the backend binds edit/write tools (`apply_mode`). When false, read/search only.
   * Auto apply is only available in the toolbar when this is on.
   */
  protected readonly editorMode = model(true);
  /** When true, backend applies proposed edits immediately without diff review pause (`auto_apply_mode`). */
  protected readonly autoApplyMode = model(false);
  /** Composer run mode: agent (ReAct) or plan (plan-and-execute). */
  protected readonly composerMode = model<ComposerRunMode>(DEFAULT_COMPOSER_RUN_MODE);
  protected readonly streamingParts = signal<StreamPart[]>([]);
  protected readonly streamingPlanner = signal<PlannerProgress | null>(null);
  /** Live build-plan markdown streamed from the planner before finalize. */
  protected readonly buildPlanLiveContent = signal<{ relativePath: string; content: string } | null>(null);
  /** Monaco model keys currently receiving live build-plan chunks (skip disk reload). */
  protected readonly buildPlanStreamingKeys = signal<ReadonlySet<string>>(new Set());
  /** Clean final reply for the active conversation (`final_text` SSE), before `[DONE]`. */
  protected readonly streamingFinalText = signal<string | undefined>(undefined);
  private readonly backgroundStreamPlanner = new Map<string, PlannerProgress>();
  /** Active build plan per conversation (preview tab + cancel lifecycle). */
  private readonly activeBuildPlanByConversation = new Map<
    string,
    { planId: string; relativePath: string; active: boolean }
  >();
  /**
   * Last measured prompt token count per conversation (from API usage metadata).
   * Persists across conversation switches until a newer measurement replaces it.
   */
  protected readonly measuredPromptTokensByConversation = signal<Record<string, number>>({});
  protected readonly activeMeasuredPromptTokens = computed(() => {
    const id = this.activeConversationId();
    if (!id) {
      return null;
    }
    const tokens = this.measuredPromptTokensByConversation()[id];
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  });
  /** Main window zoom state (frameless window controls). */
  protected readonly windowMaximized = signal(false);
  /** In-flight tool call ids for the active conversation (drives processing-row spinner color). */
  private readonly toolRunIds = signal<Set<string>>(new Set());
  /**
   * Stays true for the rest of the reply after any tool status in this turn, so the spinner stays
   * blue during follow-up LLM steps (not only the brief window while `toolRunIds` is non-empty).
   */
  private readonly toolPhaseEngaged = signal(false);
  protected readonly processingToolsActive = computed(
    () => this.toolRunIds().size > 0 || this.toolPhaseEngaged(),
  );

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
  /** Open file tab id (`file:<relativePath>`) or null when no editor tab is selected. */
  protected readonly activeMainTabId = signal<string | null>(null);
  /** Sidebar hub body: conversation list or active chat stack. */
  protected readonly chatHubView = model<ChatHubView>('activeChat');
  /** When true, active chat stack overlays the main editor stage. */
  protected readonly chatExpanded = model(false);

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

  /** True when the active file tab is an image the dedicated viewer should render. */
  protected readonly activeFileIsImage = computed(() => {
    const p = this.activeFileRelativePath();
    return !!p && isViewableImagePath(p);
  });

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
  protected readonly contextCapacity = computed(() => buildContextCapacitySnapshot({
    connection: this.activeLlmConnection(),
    messages: this.messages(),
    streamingParts: this.streamingParts(),
    workspaceContextText: this.workspaceContextText(),
    measuredPromptTokens: this.activeMeasuredPromptTokens(),
  }));
  protected readonly contextChatBlocked = computed(
    () => this.contextCapacity().usedPercentage >= CONTEXT_CHAT_BLOCKED_PERCENT,
  );
  protected readonly activeContextStatusNotice = computed(() =>
    this.contextChatBlocked() ? 'Context full — start a new conversation to continue.' : '',
  );

  // Layout
  protected readonly workspaceWidth = signal(220);
  protected readonly sidebarWidth = signal(0);

  private static readonly MIN_WORKSPACE = 140;
  private static readonly MAX_WORKSPACE = 500;
  private static readonly MIN_SIDEBAR = 140;
  private static readonly MAX_SIDEBAR = 800;
  private static readonly LAYOUT_RESIZE_HANDLES_PX = 8;
  private static readonly DEFAULT_SIDEBAR_WIDTH_PERCENT = 0.75;
  private static readonly SIDEBAR_WIDTH_SAVE_DEBOUNCE_MS = 2000;

  private activeConversation: Conversation | null = null;
  private backgroundStreamParts = new Map<string, StreamPart[]>();
  /** Final assistant text from backend (clean, without briefs) per conversation. */
  private pendingFinalText = new Map<string, string>();
  private resizing: 'workspace' | 'sidebar' | null = null;
  private boundOnResizeMove = this.onResizeMove.bind(this);
  private boundOnResizeEnd = this.onResizeEnd.bind(this);
  private boundOnWindowResize = this.onWindowResize.bind(this);
  private sidebarWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSidebarWidthPercent: number | null = null;
  private pendingSave = false;
  /** Serializes SQLite writes for the active conversation so overlapping saves cannot apply a stale snapshot after a newer one. */
  private saveCurrentConversationChain: Promise<void> = Promise.resolve();
  /** Per-conversation RMW chain for background-completed streams (read disk → append assistant). */
  private readonly backgroundConversationSaveChains = new Map<string, Promise<void>>();
  private workspaceSyncToken = 0;

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

    this.electron.workspaceFilesChanged$
      .pipe(takeUntilDestroyed())
      .subscribe((event) => {
        void this.onWorkspaceFilesChangedForEditorTabs(event);
      });

    effect(() => {
      if (!this.speechEnabled()) this.tts.invalidateSpeechPipeline();
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
      const convId = this.activeConversationId();
      const effectiveAutoApply = this.editorMode() && this.autoApplyMode();
      if (convId) {
        void this.electron.syncAutoApplyMode(convId, effectiveAutoApply);
      }
    });

    effect(() => {
      if (!this.editorMode()) {
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

    this.electron.llmTokenUsage$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, inputTokens }) => {
      if (inputTokens > 0) {
        this.setMeasuredPromptTokensForConversation(conversationId, inputTokens);
      }
    });

    this.electron.config$.pipe(takeUntilDestroyed()).subscribe((config) => {
      this.appConfig.set(config);
      const cfs = config.chatFontSizeRem;
      const nextFs =
        typeof cfs === 'number' && !Number.isNaN(cfs) ? Math.min(1.6, Math.max(0.6, +cfs.toFixed(1))) : 0.9;
      this.fontSize.set(nextFs);
      const at = config.audioTranscription;
      this.selectedVoice.set(at?.ttsVoice?.trim() || DEFAULT_KOKORO_TTS_VOICE);
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
    });

    this.electron.chunk$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, delta, streamTag }) => {
      const toolRunInProgress = this.toolRunIds().size > 0;
      if (shouldIgnoreWhitespaceOnlyModelChunkDuringTool(delta, toolRunInProgress)) {
        return;
      }
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => {
          const next = appendStreamPart(prev, streamTag, delta);
          if (this.speechEnabled()) {
            const rawPrimary = primaryAssistantTextFromParts(next);
            void this.tts.feedStreamingAssistantText(rawPrimary, this.selectedVoice(), this.ttsSpeechSpeed());
          }
          return next;
        });
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(conversationId, appendStreamPart(prev, streamTag, delta));
      }
    });

    this.electron.toolReadChunk$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, delta }) => {
      const mergeRead = (prev: StreamPart[]) => appendAndMergeReadToolPreviewChunk(prev, delta);
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => {
          const next = mergeRead(prev);
          this.syncChainTextFromReadToolTrail(next);
          return next;
        });
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(conversationId, mergeRead(prev));
      }
    });

    this.electron.toolExecChunk$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, delta, streamTag, label }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => appendStreamPart(prev, streamTag, delta, label ?? ''));
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(conversationId, appendStreamPart(prev, streamTag, delta, label ?? ''));
      }
    });

    this.electron.toolExecComplete$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, streamTag, exitCode, outputExcerpt, outcome }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) =>
          markToolExecStreamComplete(prev, streamTag, exitCode, outputExcerpt, outcome),
        );
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(
          conversationId,
          markToolExecStreamComplete(prev, streamTag, exitCode, outputExcerpt, outcome),
        );
      }
    });

    this.electron.diff$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, diff }) => {
      if (diff.version !== 1 || !Array.isArray(diff.rows)) return;
      const artifact = { role: 'diff', payload: diff, reviewStatus: 'pending' as const } satisfies ChatMessage;
      if (conversationId !== this.activeConversationId()) {
        void this.persistArtifactToConversation(conversationId, artifact);
        return;
      }
      this.messages.update((prev) => [...prev, artifact]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.stagedTransferBatch$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !Array.isArray(payload.files) || payload.files.length === 0) {
        return;
      }
      const artifact = {
        role: 'staged_transfer_batch',
        payload,
        reviewStatus: 'pending' as const,
      } satisfies ChatMessage;
      if (conversationId !== this.activeConversationId()) {
        void this.persistArtifactToConversation(conversationId, artifact);
        return;
      }
      this.messages.update((prev) => [...prev, artifact]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.acceptCommand$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'accept_command', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      if (conversationId !== this.activeConversationId()) {
        void this.persistArtifactToConversation(conversationId, artifact);
        return;
      }
      this.messages.update((prev) => [...prev, artifact]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.copyConfirm$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !Array.isArray(payload.copies) || payload.copies.length === 0) return;
      const artifact = { role: 'copy_confirm', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      if (conversationId !== this.activeConversationId()) {
        void this.persistArtifactToConversation(conversationId, artifact);
        return;
      }
      this.messages.update((prev) => [...prev, artifact]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.deleteConfirm$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId) return;
      const batchOk = Array.isArray(payload.entries) && payload.entries.length > 0;
      const singleOk = typeof payload.relativePath === 'string' && payload.relativePath.trim().length > 0;
      if (!batchOk && !singleOk) return;
      const artifact = { role: 'delete_confirm', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      if (conversationId !== this.activeConversationId()) {
        void this.persistArtifactToConversation(conversationId, artifact);
        return;
      }
      this.messages.update((prev) => [...prev, artifact]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.plannerProgress$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, planner }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingPlanner.set(planner);
      } else {
        this.backgroundStreamPlanner.set(conversationId, planner);
      }
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

    this.electron.planConfirm$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'plan_confirm', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      if (conversationId !== this.activeConversationId()) {
        void this.persistArtifactToConversation(conversationId, artifact);
        return;
      }
      this.messages.update((prev) => [...prev, artifact]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.agentQuestion$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'agent_question', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      if (conversationId !== this.activeConversationId()) {
        void this.persistArtifactToConversation(conversationId, artifact);
        return;
      }
      this.messages.update((prev) => [...prev, artifact]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.llmStatus$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, status }) => {
      if (conversationId !== this.activeConversationId()) return;
      const src = (status.source ?? 'agent').toLowerCase();
      if (src === 'tool') {
        this.toolPhaseEngaged.set(true);
        // Defer so RAF-batched `tool_read_chunk` updates land before complete/error overwrites text.
        queueMicrotask(() => {
          if (conversationId !== this.activeConversationId()) return;
          this.applyToolLlmStatus(status);
        });
        return;
      }
      this.upsertChainMessage(status);
    });

    this.electron.finalText$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, text }) => {
      this.pendingFinalText.set(conversationId, text);
      if (conversationId === this.activeConversationId()) {
        this.streamingFinalText.set(text);
      }
    });

    this.electron.done$.pipe(takeUntilDestroyed()).subscribe(({ conversationId }) => {
      this.removePending(conversationId);
      const parts =
        conversationId === this.activeConversationId()
          ? this.streamingParts()
          : (this.backgroundStreamParts.get(conversationId) ?? []);
      const turn = buildAssistantTurnFromStreamParts(parts, this.pendingFinalText.get(conversationId));
      const planner =
        conversationId === this.activeConversationId()
          ? this.streamingPlanner()
          : (this.backgroundStreamPlanner.get(conversationId) ?? null);
      this.pendingFinalText.delete(conversationId);
      this.backgroundStreamPlanner.delete(conversationId);

      if (planner?.phase === 'complete') {
        this.setBuildPlanTabInactive(conversationId);
      }

      if (conversationId === this.activeConversationId()) {
        this.toolRunIds.set(new Set());
        this.toolPhaseEngaged.set(false);
        this.streamingParts.set([]);
        this.streamingPlanner.set(null);
        this.streamingFinalText.set(undefined);
        if (turn) {
          this.pushMessage(
            'assistant',
            turn.text,
            turn.toolStreams,
            turn.reasoningStreams,
            turn.auxiliaryStreamTimeline,
            planner ?? undefined,
          );
          if (this.speechEnabled()) {
            const streamedPrimary = primaryAssistantTextFromParts(parts);
            const ttsText = streamedPrimary.trim() ? streamedPrimary : turn.text;
            if (ttsText.trim()) {
              void this.tts.flushStreamingAssistantText(ttsText, this.selectedVoice(), this.ttsSpeechSpeed());
            }
          }
          void this.persistActiveAssistantTurnThenMaybeAutoTitle(conversationId).catch((err) =>
            console.error('[App] persist assistant / auto-title failed', err),
          );
        }
      } else {
        this.backgroundStreamParts.delete(conversationId);
        if (turn) {
          void this.saveMessageToConversation(
            conversationId,
            turn.text,
            turn.toolStreams,
            turn.reasoningStreams,
            turn.auxiliaryStreamTimeline,
            planner ?? undefined,
          )
            .then(() => this.applyMaybeAutoTitleFromMain(conversationId))
            .catch((err) => console.error('[App] background save / auto-title failed', err));
        }
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

    if (this.electron.isElectron) {
      this.windowMaximized.set(await this.electron.windowIsMaximized());
    }

    this.syncSidebarWidthFromEffectivePercent();
    window.addEventListener('resize', this.boundOnWindowResize);

    // Load conversations for current workspace
    await this.loadConversationsForWorkspace();
  }

  ngOnDestroy(): void {
    this.tts.invalidateSpeechPipeline();
    window.removeEventListener('resize', this.boundOnWindowResize);
    this.flushSidebarWidthPersist();
    this.onResizeEnd();
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

  private async loadConversationsForWorkspace(): Promise<void> {
    const wsId = this.currentWorkspaceId();
    console.log('[App] loadConversationsForWorkspace: wsId:', wsId);
    const config = await this.electron.loadConfig();
    const list = await this.electron.getConversations(wsId);
    console.log('[App] loadConversationsForWorkspace: got', list.length, 'conversations');
    this.conversations.set(list);

    if (list.length === 0) {
      // No conversations in this workspace, create one
      console.log('[App] loadConversationsForWorkspace: no conversations, creating new');
      await this.onNewConversation();
    } else {
      const key = wsId ?? '';
      const remembered = config.lastActiveConversationByWorkspaceId?.[key];
      const match = remembered ? list.find((c) => c.id === remembered) : undefined;
      const conv = match ?? list[0];
      console.log(
        '[App] loadConversationsForWorkspace: loading conv:',
        conv.id,
        'workspaceId:',
        conv.workspaceId,
        'restoredFromMemory:',
        Boolean(remembered && match),
      );
      await this.loadConversation(conv.id, conv.workspaceId);
    }
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
    const structuredContent = await this.buildStructuredContent(normalized, attachments);
    this.clearChatContextFiles();
    this.pushMessage('user', normalized, undefined, undefined, undefined, undefined, structuredContent);
    this.addPending(convId);
    this.toolPhaseEngaged.set(false);
    if (this.speechEnabled()) {
      this.tts.beginAssistantSpeechTurn();
    }
    this.streamingParts.set([]);
    this.streamingPlanner.set(null);
    this.streamingFinalText.set(undefined);
    const workspaceId = this.activeConversation?.workspaceId ?? this.currentWorkspaceId();
    this.electron.sendMessage(
      convId,
      normalized,
      this.editorMode(),
      this.editorMode() && this.autoApplyMode(),
      structuredContent,
      workspaceId,
      this.composerMode(),
    );
    this.autoSave();
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
      if (file.kind === 'image' && root) {
        const res = await this.electron.readWorkspaceImageBase64(root, file.relativePath);
        if (res.ok && res.dataUrl) {
          blocks.push({ type: 'image_url', image_url: { url: res.dataUrl } });
          continue;
        }
      }
      blocks.push({ type: 'text', text: formatAttachedFileText(file) });
    }
    return blocks.length > 0 ? blocks : undefined;
  }

  async onNewConversation(): Promise<void> {
    await this.saveCurrentConversation();
    const workspaceId = this.currentWorkspaceId();
    const conv = await this.electron.newConversation(workspaceId);
    this.activeConversation = conv;
    this.activeConversationId.set(conv.id);
    this.messages.set([]);
    this.toolRunIds.set(new Set());
    this.toolPhaseEngaged.set(false);
    this.streamingParts.set([]);
    this.streamingFinalText.set(undefined);
    const config = await this.electron.loadConfig();
    applyAppTheme(resolveAppThemeId(config));
    await this.refreshConversationList();
    await this.rememberLastActiveForWorkspace(conv);
    this.chatHubView.set('activeChat');
  }

  onAbortRequested(): void {
    const convId = this.activeConversationId();
    if (!convId || !this.pendingIds().has(convId)) return;
    void this.electron.abortMessage(convId);
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
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
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
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
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
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
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
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
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
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
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
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
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
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
  }

  async onSelectConversation(id: string): Promise<void> {
    if (id === this.activeConversationId()) return;
    console.log('[App] onSelectConversation:', id);
    await this.saveCurrentConversation();
    // Use the conversation's own workspaceId
    const conv = this.conversations().find(c => c.id === id);
    const convWorkspaceId = conv?.workspaceId ?? this.currentWorkspaceId();
    console.log('[App] onSelectConversation: convWorkspaceId:', convWorkspaceId);
    await this.loadConversation(id, convWorkspaceId);
    this.chatHubView.set('activeChat');
  }

  async onDeleteConversation(id: string): Promise<void> {
    // Use the conversation's own workspaceId to delete
    const conv = this.conversations().find(c => c.id === id);
    const convWorkspaceId = conv?.workspaceId ?? this.currentWorkspaceId();
    await this.electron.deleteConversation(id, convWorkspaceId);
    this.removeContextMetricsForConversation(id);
    const isActive = id === this.activeConversationId();

    // Refresh the conversation list for the current workspace
    const wsId = this.currentWorkspaceId();
    const list = await this.electron.getConversations(wsId);
    this.conversations.set(list);

    if (isActive) {
      this.activeConversation = null;
      if (list.length > 0) {
        const nextConv = list[0];
        await this.loadConversation(nextConv.id, nextConv.workspaceId ?? wsId);
      } else {
        await this.onNewConversation();
      }
    }
  }

  async onRenameConversation(event: { id: string; title: string }): Promise<void> {
    // Use the conversation's own workspaceId to rename
    const conv = this.conversations().find(c => c.id === event.id);
    const convWorkspaceId = conv?.workspaceId ?? this.currentWorkspaceId();
    console.log('[App] onRenameConversation:', { id: event.id, title: event.title, convWorkspaceId });
    await this.electron.renameConversation(event.id, event.title, convWorkspaceId);
    if (this.activeConversation && this.activeConversation.id === event.id) {
      this.activeConversation.title = event.title;
      this.activeConversation.customTitle = true;
      console.log('[App] Updated activeConversation.title to:', event.title);
    }
    // Update the list in place so the sidebar title changes immediately.
    this.updateConversationMeta(event.id, {
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
    await this.saveCurrentConversation();

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

  protected async closeMainFileTab(event: MouseEvent, tabId: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!tabId.startsWith('file:')) {
      return;
    }
    const modelKey = tabId.slice(5);
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
        return;
      }
      const convId = this.activeConversationId();
      if (convId) {
        await this.electron.cancelBuildPlan(convId, tab.buildPlanId);
        void this.electron.abortMessage(convId);
        this.activeBuildPlanByConversation.delete(convId);
      }
      this.removeFileTabByModelKey(keyToClose);
      return;
    }

    if (detached && unsaved) {
      const choice = await this.themedConfirm.open(detachedFileClosePrompt(displayPath));
      if (choice === 'cancel') {
        return;
      }
      if (choice === 'middle') {
        const newKey = await this.workspaceMonaco?.saveAsForKey(modelKey);
        if (!newKey) {
          return;
        }
        keyToClose = newKey;
      } else if (choice === 'confirm') {
        await this.workspaceMonaco?.cleanupDetachedForKey(modelKey);
      }
    } else if (unsaved) {
      const discard = await this.themedConfirm.open(unsavedCloseFileTabPrompt(displayPath));
      if (discard !== 'confirm') {
        return;
      }
    } else if (detached) {
      await this.workspaceMonaco?.cleanupDetachedForKey(modelKey);
    }

    this.removeFileTabByModelKey(keyToClose);
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

  private pushMessage(
    role: 'user' | 'assistant',
    text: string,
    toolStreams?: StreamPart[],
    reasoningStreams?: StreamPart[],
    auxiliaryStreamTimeline?: StreamPart[],
    planner?: PlannerProgress,
    structuredContent?: readonly ChatStructuredContentPart[],
  ): void {
    console.log('[App] pushMessage:', role, 'text length:', text.length);
    let nextMessage: ChatMessage;
    if (role === 'user') {
      nextMessage = structuredContent?.length ? { role, text, structuredContent } : { role, text };
    } else {
      const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text };
      if (toolStreams?.length) assistant.toolStreams = toolStreams;
      if (reasoningStreams?.length) assistant.reasoningStreams = reasoningStreams;
      if (auxiliaryStreamTimeline?.length) assistant.auxiliaryStreamTimeline = auxiliaryStreamTimeline;
      if (planner) assistant.planner = planner;
      nextMessage = assistant;
    }
    this.messages.update((prev) => [...prev, nextMessage]);
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      console.log('[App] pushMessage: pendingSave set to true');
    }
  }

  private async rememberLastActiveForWorkspace(conv: Conversation): Promise<void> {
    const key = conv.workspaceId ?? '';
    await this.electron.setLastActiveConversation(key, conv.id);
  }

  private async loadConversation(
    id: string,
    workspaceId?: string | null,
    loadOpts?: { skipPythonResync?: boolean },
  ): Promise<void> {
    const skipPython =
      loadOpts?.skipPythonResync !== undefined
        ? loadOpts.skipPythonResync
        : this.pendingIds().has(id);
    const conv = await this.electron.loadConversation(id, workspaceId, { skipPythonResync: skipPython });
    this.activeConversation = conv;
    this.activeConversationId.set(conv.id);
    this.messages.set(conv.messages);
    this.toolRunIds.set(new Set());
    this.toolPhaseEngaged.set(false);
    const stillStreaming = this.pendingIds().has(conv.id);
    if (stillStreaming) {
      const bgParts = this.backgroundStreamParts.get(conv.id) ?? [];
      this.streamingParts.set(bgParts.length ? [...bgParts] : []);
      this.backgroundStreamParts.delete(conv.id);
      this.streamingFinalText.set(this.pendingFinalText.get(conv.id));
    } else {
      this.streamingParts.set([]);
      this.backgroundStreamParts.delete(conv.id);
      this.streamingFinalText.set(undefined);
    }

    const config = await this.electron.loadConfig();
    applyAppTheme(resolveAppThemeId(config));
    await this.rememberLastActiveForWorkspace(conv);
  }

  private async saveCurrentConversation(): Promise<void> {
    const p = this.saveCurrentConversationChain.then(() => this.flushSaveCurrentConversation());
    this.saveCurrentConversationChain = p.catch((err) => {
      console.error('[App] saveCurrentConversation chain failed:', err);
    });
    return p;
  }

  private async flushSaveCurrentConversation(): Promise<void> {
    if (!this.activeConversation) {
      console.log('[App] saveCurrentConversation: no active conversation');
      return;
    }
    let flushed = false;
    while (this.pendingSave) {
      flushed = true;
      console.log('[App] saveCurrentConversation: flushing dirty state');
      this.pendingSave = false;
      this.activeConversation.messages = [...this.messages()];
      this.activeConversation.updatedAt = new Date().toISOString();
      console.log('[App] Saving conversation with', this.activeConversation.messages.length, 'messages');
      await this.electron.saveConversation(this.activeConversation);
      console.log('[App] Conversation saved successfully');
    }
    if (!flushed) {
      console.log('[App] saveCurrentConversation: skipping, pendingSave was false');
    }
  }

  private autoSave(): void {
    console.log('[App] autoSave called');
    this.saveCurrentConversation().then(() => {
      const id = this.activeConversationId();
      if (id) this.bumpConversation(id);
    });
  }

  private async persistActiveAssistantTurnThenMaybeAutoTitle(conversationId: string): Promise<void> {
    await this.saveCurrentConversation();
    const id = this.activeConversationId();
    if (id) this.bumpConversation(id);
    await this.applyMaybeAutoTitleFromMain(conversationId);
  }

  private async applyMaybeAutoTitleFromMain(conversationId: string): Promise<void> {
    try {
      const r = await this.electron.maybeAutoTitleConversation(conversationId);
      if (r.ok) {
        if (this.activeConversation?.id === conversationId) {
          this.activeConversation.title = r.title;
        }
        this.updateConversationMeta(conversationId, { title: r.title, updatedAt: r.updatedAt });
      }
    } catch {
      // ignore IPC failures
    }
  }

  private async saveMessageToConversation(
    conversationId: string,
    text: string,
    toolStreams?: StreamPart[],
    reasoningStreams?: StreamPart[],
    auxiliaryStreamTimeline?: StreamPart[],
    planner?: PlannerProgress,
  ): Promise<void> {
    const prev = this.backgroundConversationSaveChains.get(conversationId) ?? Promise.resolve();
    const mine = prev.then(async () => {
      try {
        const convMeta = this.conversations().find(c => c.id === conversationId);
        const workspaceId = convMeta?.workspaceId ?? this.currentWorkspaceId();
        const conv = await this.electron.readConversationFromDisk(conversationId, workspaceId);
        const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text };
        if (toolStreams?.length) assistant.toolStreams = toolStreams;
        if (reasoningStreams?.length) assistant.reasoningStreams = reasoningStreams;
        if (auxiliaryStreamTimeline?.length) assistant.auxiliaryStreamTimeline = auxiliaryStreamTimeline;
        if (planner) assistant.planner = planner;
        conv.messages.push(assistant);
        conv.updatedAt = new Date().toISOString();
        await this.electron.saveConversation(conv);
        this.bumpConversation(conversationId);
      } catch {
        // conversation may have been deleted
      }
    });
    this.backgroundConversationSaveChains.set(
      conversationId,
      mine.catch((err) => console.error('[App] background conversation save failed:', err)),
    );
    return mine;
  }

  /**
   * Persist a HITL artifact (diff / delete / copy / accept-command confirmation) to a conversation
   * that is not currently active. Without this, the artifact is dropped and the backend agent stays
   * paused forever waiting for a confirmation the user can never send. Persisting lets the pending
   * card re-surface when the conversation is reopened so the user can still confirm or cancel.
   */
  private async persistArtifactToConversation(
    conversationId: string,
    message: ChatMessage,
  ): Promise<void> {
    const prev = this.backgroundConversationSaveChains.get(conversationId) ?? Promise.resolve();
    const mine = prev.then(async () => {
      try {
        const convMeta = this.conversations().find(c => c.id === conversationId);
        const workspaceId = convMeta?.workspaceId ?? this.currentWorkspaceId();
        const conv = await this.electron.readConversationFromDisk(conversationId, workspaceId);
        conv.messages.push(message);
        conv.updatedAt = new Date().toISOString();
        await this.electron.saveConversation(conv);
        this.bumpConversation(conversationId);
      } catch {
        // conversation may have been deleted
      }
    });
    this.backgroundConversationSaveChains.set(
      conversationId,
      mine.catch((err) => console.error('[App] background artifact save failed:', err)),
    );
    return mine;
  }

  private bumpConversation(id: string): void {
    this.updateConversationMeta(id, { updatedAt: new Date().toISOString() });
  }

  private updateConversationMeta(id: string, changes: Partial<ConversationMeta>): void {
    this.conversations.update((list) => {
      const updated = list.map((c) => c.id === id ? { ...c, ...changes } : c);
      updated.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return updated;
    });
  }

  /** Apply one tool-row status after batched read-preview chunks have been merged. */
  private applyToolLlmStatus(status: LlmStatus): void {
    if (status.state === 'running') {
      this.toolRunIds.update((s) => new Set(s).add(status.id));
    }
    if (status.state === 'complete' || status.state === 'error') {
      this.toolRunIds.update((s) => {
        const next = new Set(s);
        next.delete(status.id);
        return next;
      });
    }
    this.streamingParts.update((prev) => {
      const next = upsertToolTrailStatusStreamPart(prev, status);
      this.upsertChainMessage(status, this.chainTextForToolStatus(next, status));
      return next;
    });
  }

  /** Prefer multiplex tool-trail text (includes streamed read preview) over the status one-liner. */
  private chainTextForToolStatus(parts: StreamPart[], status: LlmStatus): string {
    const streamTag = toolTrailStatusStreamTag(status.id);
    const part = parts.find((p) => p.streamTag === streamTag);
    if (part?.text?.trim()) {
      return part.text;
    }
    return status.detail ?? '';
  }

  private syncChainTextFromReadToolTrail(parts: StreamPart[]): void {
    const idx = findReadToolTrailTargetIndex(parts);
    if (idx < 0) {
      return;
    }
    const part = parts[idx]!;
    const statusId = toolTrailStatusIdFromStreamTag(part.streamTag);
    if (!statusId) {
      return;
    }
    this.messages.update((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'chain' && m.statusId === statusId) {
          const copy = [...prev];
          copy[i] = { ...m, text: part.text };
          return copy;
        }
      }
      return prev;
    });
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
    }
  }

  /** Merge status updates by backend `id` so a later `complete`/`error` row replaces the running row instead of leaving it spinning. */
  private upsertChainMessage(status: LlmStatus, textOverride?: string): void {
    const text = textOverride ?? status.detail ?? '';
    this.messages.update((prev) => {
      const nextRow: ChatMessage = {
        role: 'chain',
        label: status.label,
        text,
        state: status.state,
        source: status.source,
        statusId: status.id,
        ...(status.agentRole ? { agentRole: status.agentRole } : {}),
        ...(status.streamTag ? { streamTag: status.streamTag } : {}),
      };
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'chain' && m.statusId === status.id) {
          const copy = [...prev];
          copy[i] = nextRow;
          return copy;
        }
      }
      return [...prev, nextRow];
    });
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
    }
  }

  private addPending(id: string): void {
    this.pendingIds.update((s) => new Set(s).add(id));
  }

  private removePending(id: string): void {
    this.pendingIds.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  private getPendingStreamIdsForWorkspace(workspaceId: string | null): string[] {
    return [...this.pendingIds()].filter((id) => {
      const conv = this.conversations().find((c) => c.id === id);
      if (conv) {
        return (conv.workspaceId ?? null) === workspaceId;
      }
      if (id === this.activeConversationId() && this.activeConversation) {
        return (this.activeConversation.workspaceId ?? null) === workspaceId;
      }
      return false;
    });
  }

  private async abortPendingStreamsForWorkspace(workspaceId: string | null): Promise<void> {
    const ids = this.getPendingStreamIdsForWorkspace(workspaceId);
    await Promise.all(ids.map((id) => this.electron.abortMessage(id)));
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

    const pending = this.getPendingStreamIdsForWorkspace(fromWorkspaceId);
    if (pending.length > 0) {
      const proceed = (await this.themedConfirm.open(activeStreamWorkspaceSwitchPrompt(pending.length))) === 'confirm';
      if (!proceed) {
        return false;
      }
      await this.abortPendingStreamsForWorkspace(fromWorkspaceId);
    }

    return true;
  }

  private async refreshConversationList(): Promise<void> {
    const wsId = this.currentWorkspaceId();
    const list = await this.electron.getConversations(wsId);
    this.conversations.set(list);
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

    await this.saveCurrentConversation();
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

    await this.loadConversation(conv.id, conv.workspaceId, { skipPythonResync: skipTargetPython });
    this.chatHubView.set('activeChat');
  }

  protected onChromeFileMenu(ev: MouseEvent): void {
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    void this.electron.popupFileMenu(Math.floor(r.left), Math.floor(r.bottom));
  }

  protected onChromeHelpMenu(ev: MouseEvent): void {
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    void this.electron.popupHelpMenu(Math.floor(r.left), Math.floor(r.bottom));
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

  private setMeasuredPromptTokensForConversation(conversationId: string, tokens: number): void {
    if (!conversationId || tokens <= 0) {
      return;
    }
    this.measuredPromptTokensByConversation.update((prev) => ({
      ...prev,
      [conversationId]: Math.floor(tokens),
    }));
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
  }
}
