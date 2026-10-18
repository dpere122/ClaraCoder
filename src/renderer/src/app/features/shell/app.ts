/**
 * Main chat shell: conversations, workspace chrome, IPC-driven streaming, and layout resize handles.
 * TTS playback lives in {@link TtsPlaybackService}; this component wires signals and `ElectronService` streams.
 */
import { afterNextRender, Component, computed, effect, HostListener, inject, Injector, model, NgZone, OnDestroy, OnInit, QueryList, signal, untracked, ViewChild, ViewChildren } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  ChatStructuredContentPart,
  ConversationFileJournalEntry,
  ComposerRunMode,
  Workspace,
  WorkspaceFilesChangedMessage,
  WorkspaceOpenTabsState,
  LspEditorDiagnostic,
  LlmConnectionConfig,
  LlmReasoningSettingChange,
  MenuFileCommand,
  ThemeProposalFinishedEvent,
} from '@shared/index';
import {
  fallbackJournalFromMessages,
  invertJournalEntries,
  journalPreviewPaths,
  journalUserIdsToInvert,
  resolveRestoreUserIndex,
  acceptCommandGrantsAdminElevation,
  createAdminElevationAcceptPayload,
  isAdminElevationKind,
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
  resolveStartupWorkspaceId,
  retainRendererWorkspaceOpenTabs,
  reorderFavoriteWorkspaces,
  setWorkspaceFavorite,
  sortRecentWorkspaces,
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
  replaceFileTabAfterSaveAs,
  retargetFileTabPath,
  type ChatFileTab,
  turnDiffChatFileTab,
  workspaceChatFileTab,
  buildPlanChatFileTab,
} from './app-chat-file-tabs';
import {
  addTabToSlot,
  allTabsFlat,
  firstSlotId,
  removeTabEverywhere,
  removeTabFromSlot,
  resolveFocusedSlotId,
  setActiveTab,
  singleSlotLayout,
  slotById,
  slotIdsContainingModelKey,
  slotIdsContainingTabId,
  splitSlotWithNewTab,
  updateTabsEverywhere,
  type EditorGridLayout,
  type EditorGridSlot,
} from './editor-grid/editor-grid-layout';
import { editorGridLayoutFromPersistedState, serializeEditorGridOpenTabs } from './editor-grid/editor-grid-persistence';
import { EditorGridComponent, type EditorGridFileDrop } from './editor-grid/editor-grid';
import {
  isTurnDiffModelKey,
  relativePathFromModelKey,
  TURN_DIFF_MODEL_KEY_PREFIX,
  type OpenEditorFileRef,
} from '../workspace/open-editor-file-ref';
import {
  WorkspaceMonacoModelStore,
  type WorkspaceMonacoSaveAsResult,
} from '../workspace/workspace-monaco/workspace-monaco-model-store';
import { applyAppFontOverrides } from '../../core/theme/app-font-overrides';
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
import {
  WorkspaceMonacoComponent,
  type WorkspaceMonacoReadOnlyDiff,
} from '../workspace/workspace-monaco/workspace-monaco';
import type { TurnDiffOpenRequest } from '../chat/chat-box/turn-edits-footer/turn-edits-footer';
import type { EditorOutlineSymbol } from '../workspace/editor-outline/editor-outline';
import { editorModelKeyForRelativePath } from '../workspace/open-editor-file-ref';
import { ImageViewerComponent } from '../workspace/image-viewer/image-viewer';
import { isViewableImagePath } from '../workspace/image-viewer/image-viewer-formats';
import { planOpenWorkspaceImageTab } from './app-image-file-tabs';
import { WorkspaceTerminalDockComponent } from '../workspace-terminal/workspace-terminal-dock';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { ThemedConfirmDialogService } from '../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { ThemedConfirmDialogComponent } from '../../shared/themed-confirm-dialog/themed-confirm-dialog';
import { ThemedPromptDialogComponent } from '../../shared/themed-prompt-dialog/themed-prompt-dialog';
import {
  activeStreamWorkspaceSwitchPrompt,
  unsavedCloseFileTabPrompt,
  unsavedWorkspaceSwitchPrompt,
  detachedFileClosePrompt,
  activeBuildPlanClosePrompt,
  closeWorkspacePrompt,
} from '../../shared/themed-confirm-dialog/format-unsaved-workspace-detail';
import { normalizePathSlashes, workspaceRelativePathIfUnderRoot } from '../../utils/workspace-relative-path';
import { LucideAngularModule } from 'lucide-angular';
import { NgxSpinnerComponent, NgxSpinnerService } from 'ngx-spinner';
import type { AcceptCommandFinishedEvent } from '@shared/index';

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

/** Editor bindings for one grid slot (what its Monaco / image viewer should show). */
export interface EditorGridSlotView {
  slotId: string;
  activeTabId: string | null;
  /** Active model key, or null when the slot has no tab. */
  activeModelKey: string | null;
  activeRelativePath: string | null;
  /** True when the active tab is an image rendered by the image viewer. */
  activeIsImage: boolean;
  /** Monaco-only active key (null for image tabs). */
  monacoActiveModelKey: string | null;
  monacoActiveRelativePath: string | null;
  imageRelativePath: string | null;
  /** Text-file refs Monaco should hold models for. */
  monacoOpenEditorFiles: OpenEditorFileRef[];
  monacoOpenFileRelativePaths: string[];
}

export function editorGridSlotView(slot: EditorGridSlot): EditorGridSlotView {
  const activeTabId = slot.activeTabId;
  const activeModelKey = activeTabId?.startsWith('file:')
    ? activeTabId.slice(5) || null
    : isTurnDiffModelKey(activeTabId)
      ? activeTabId
      : null;
  const activeRelativePath = activeModelKey ? relativePathFromModelKey(activeModelKey) : null;
  const activeIsImage = !!activeRelativePath && isViewableImagePath(activeRelativePath);
  const monacoOpenEditorFiles = slot.tabs
    .map((t) => openEditorFileRefFromTab(t))
    .filter((f): f is NonNullable<typeof f> => {
      if (!f) {
        return false;
      }
      if (f.outsideWorkspace) {
        return true;
      }
      return !isViewableImagePath(f.relativePath ?? '');
    });
  const monacoOpenFileRelativePaths = slot.tabs
    .map((t) => t.relativePath)
    .filter((p): p is string => !!p?.trim() && !isViewableImagePath(p));
  return {
    slotId: slot.id,
    activeTabId,
    activeModelKey,
    activeRelativePath,
    activeIsImage,
    monacoActiveModelKey: activeIsImage ? null : activeModelKey,
    monacoActiveRelativePath: activeIsImage ? null : activeRelativePath,
    imageRelativePath: activeIsImage ? activeRelativePath : null,
    monacoOpenEditorFiles,
    monacoOpenFileRelativePaths,
  };
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
    EditorGridComponent,
    NgxSpinnerComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  @ViewChildren(WorkspaceMonacoComponent) private workspaceMonacos?: QueryList<WorkspaceMonacoComponent>;
  @ViewChild(WorkspaceComponent) private workspacePanel?: WorkspaceComponent;
  @ViewChild(WorkspaceTerminalDockComponent) private workspaceTerminalDock?: WorkspaceTerminalDockComponent;
  private readonly monacoStore = inject(WorkspaceMonacoModelStore);
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
  /** Per-conversation admin ``run_command`` grant, shown as the composer Admin chip. */
  protected readonly adminElevationGranted = model(false);
  private readonly adminElevationByConversation = new Map<string, boolean>();
  private lastAdminElevationConversationId: string | null = null;
  /** True while the Admin-chip grant HITL is waiting in this conversation. */
  protected readonly adminElevationPending = computed(() =>
    this.messages().some(
      (m) =>
        m.role === 'accept_command' &&
        isAdminElevationKind(m.payload.kind) &&
        (m.reviewStatus ?? 'pending') === 'pending',
    ),
  );
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
  /** Welcome-screen preference: skip restoring the last workspace on launch. */
  protected readonly defaultHomePageOnStart = signal(false);
  /**
   * After a home-on-start launch, ignore persisted `currentWorkspaceId` from config
   * broadcasts until the user opens a workspace this session.
   */
  private holdStartupHomePage = false;
  protected readonly workspaceContextText = signal('');
  protected readonly currentWorkspace = computed(() => {
    const id = this.currentWorkspaceId();
    return this.workspaces().find(w => w.id === id) ?? null;
  });
  protected readonly currentWorkspacePath = computed(() => this.currentWorkspace()?.path?.trim() ?? '');
  /** Editor grid: up to 3 columns x 3 slots, each slot a tab group with its own Monaco instance. */
  protected readonly editorGrid = signal<EditorGridLayout>(singleSlotLayout());
  /** Slot that owns keyboard focus; shell-level editor bindings (outline, diff, reveal) follow it. */
  protected readonly focusedSlotId = signal<string | null>(firstSlotId(this.editorGrid()));
  protected readonly focusedSlot = computed<EditorGridSlot | null>(() => {
    const layout = this.editorGrid();
    return slotById(layout, this.focusedSlotId()) ?? layout.columns[0]?.slots[0] ?? null;
  });
  /** Open file tabs of the focused slot (paths relative to current workspace). */
  protected readonly fileTabs = computed<ChatFileTab[]>(() => this.focusedSlot()?.tabs ?? []);
  /** Every open tab across the grid, de-duplicated by model key. */
  protected readonly allFileTabs = computed(() => allTabsFlat(this.editorGrid()));
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
  /** Model keys with unsaved Monaco buffers (shared store; mirrored to main for workspace-switch confirm). */
  protected readonly monacoUnsavedPaths = this.monacoStore.unsavedKeys;
  protected readonly monacoDetachedPaths = this.monacoStore.detachedKeys;
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
  /** Active tab id (`file:<modelKey>`) of the focused slot, or null when it has no tabs. */
  protected readonly activeMainTabId = computed<string | null>(() => this.focusedSlot()?.activeTabId ?? null);
  protected readonly fileTabContextMenuVisible = signal(false);
  protected readonly fileTabContextMenuX = signal(0);
  protected readonly fileTabContextMenuY = signal(0);
  protected readonly fileTabContextMenuTabId = signal<string | null>(null);
  protected readonly fileTabContextMenuSlotId = signal<string | null>(null);
  private readonly fileTabContextMenuTabs = computed<ChatFileTab[]>(
    () => slotById(this.editorGrid(), this.fileTabContextMenuSlotId())?.tabs ?? [],
  );
  /** Titlebar File / Settings dropdown (`null` when closed). */
  protected readonly chromeMenu = signal<'settings' | 'file' | 'file-recent' | null>(null);
  protected readonly chromeMenuX = signal(0);
  protected readonly chromeMenuY = signal(0);
  protected readonly chromeRecentMenuX = signal(0);
  protected readonly chromeRecentMenuY = signal(0);
  protected readonly chromeSettingsTabs = SETTINGS_TABS;
  protected readonly recentWorkspaces = computed(() => sortRecentWorkspaces(this.workspaces()));
  protected readonly hasOpenWorkspace = computed(() => !!this.currentWorkspaceId());
  protected readonly chromeAccelMod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
    ? '⌘'
    : 'Ctrl';
  protected readonly fileTabContextMenuCanCloseLeft = computed(() => {
    const tabId = this.fileTabContextMenuTabId();
    if (!tabId) {
      return false;
    }
    return fileTabIdsToLeft(this.fileTabContextMenuTabs(), tabId).length > 0;
  });
  protected readonly fileTabContextMenuCanCloseRight = computed(() => {
    const tabId = this.fileTabContextMenuTabId();
    if (!tabId) {
      return false;
    }
    return fileTabIdsToRight(this.fileTabContextMenuTabs(), tabId).length > 0;
  });
  /** When true, active chat stack overlays the main editor stage. */
  protected readonly chatExpanded = model(false);
  /** When true, the chat sidebar collapses to a thin bar holding only the un-collapse button. */
  protected readonly chatCollapsed = model(false);
  /** Skip persisting chat chrome until the first config load has hydrated the signals. */
  private chatLayoutHydrated = false;
  /** Skip open-tab persist/restore until the first config load. */
  private openTabsHydrated = false;
  /** Workspace whose `fileTabs` currently belong to; used to persist before restore. */
  private openTabsOwnedWorkspaceId: string | null = null;
  private applyingRestoredOpenTabs = false;
  private lastPersistedOpenTabsJson = '';

  /** Width of the sidebar when the chat is collapsed (just the un-collapse button + padding). */
  private static readonly CHAT_COLLAPSED_WIDTH_PX = 48;
  protected readonly effectiveSidebarWidth = computed(() =>
    this.chatCollapsed() ? App.CHAT_COLLAPSED_WIDTH_PX : this.sidebarWidth(),
  );

  /** Relative paths of every open tab across the grid (workspace tree highlighting). */
  protected readonly openFileRelativePaths = computed(() =>
    this.allFileTabs()
      .map((t) => t.relativePath)
      .filter((p): p is string => !!p?.trim()),
  );

  /**
   * Per-slot editor bindings, memoised on the layout so `app-workspace-monaco` inputs keep
   * stable references between change-detection passes.
   */
  protected readonly slotViews = computed(() => {
    const views = new Map<string, EditorGridSlotView>();
    for (const column of this.editorGrid().columns) {
      for (const slot of column.slots) {
        views.set(slot.id, editorGridSlotView(slot));
      }
    }
    return views;
  });

  protected slotView(slot: EditorGridSlot): EditorGridSlotView {
    return this.slotViews().get(slot.id) ?? editorGridSlotView(slot);
  }

  /** Every text-file ref open in any slot, de-duplicated by model key (for the store's grid claim). */
  protected readonly gridOpenEditorFiles = computed<OpenEditorFileRef[]>(() => {
    const byKey = new Map<string, OpenEditorFileRef>();
    for (const view of this.slotViews().values()) {
      for (const ref of view.monacoOpenEditorFiles) {
        if (ref.modelKey && !byKey.has(ref.modelKey)) {
          byKey.set(ref.modelKey, ref);
        }
      }
    }
    return [...byKey.values()];
  });

  protected readonly activeModelKey = computed(() => {
    const tabId = this.activeMainTabId();
    if (!tabId?.startsWith('file:')) {
      return null;
    }
    return tabId.slice(5) || null;
  });

  protected readonly mainStageShowsEmptyState = computed(
    () => !this.hasOpenWorkspace() || (this.allFileTabs().length === 0 && !this.chatExpanded()),
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

  /** Model keys for build-plan tabs that should open in preview-only mode. */
  protected readonly monacoForcePreviewKeys = computed(() => {
    const keys = new Set<string>();
    for (const tab of this.allFileTabs()) {
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

  /** Loaded before/after text per open turn-diff tab, keyed by its `turn-diff:` model key. */
  protected readonly turnDiffContents = signal<ReadonlyMap<string, WorkspaceMonacoReadOnlyDiff>>(new Map());

  /** Read-only diff for a slot whose active tab is a turn-diff tab (null until loaded). */
  protected turnDiffForSlot(view: EditorGridSlotView): WorkspaceMonacoReadOnlyDiff | null {
    const key = view.monacoActiveModelKey;
    if (!key?.startsWith(TURN_DIFF_MODEL_KEY_PREFIX)) {
      return null;
    }
    return this.turnDiffContents().get(key) ?? null;
  }

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
  ) {
    this.electron.windowMaximized$
      .pipe(takeUntilDestroyed())
      .subscribe((maximized) => this.windowMaximized.set(maximized));

    this.electron.editorFindRequested$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.onEditorFindRequested());

    this.electron.menuFileCommand$
      .pipe(takeUntilDestroyed())
      .subscribe((command) => this.onMenuFileCommand(command));

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
      const convId = this.activeConversationId();
      if (convId === this.lastAdminElevationConversationId) {
        return;
      }
      this.lastAdminElevationConversationId = convId;
      untracked(() => {
        const granted = this.adminElevationByConversation.get(convId ?? '') ?? false;
        this.adminElevationGranted.set(granted);
        if (convId) {
          void this.electron.syncAdminElevation(convId, granted);
        }
      });
    });

    effect(() => {
      const granted = this.adminElevationGranted();
      const convId = untracked(() => this.activeConversationId());
      if (!convId) {
        return;
      }
      const previous = this.adminElevationByConversation.get(convId) ?? false;
      if (previous === granted) {
        return;
      }
      this.adminElevationByConversation.set(convId, granted);
      void this.electron.syncAdminElevation(convId, granted);
    });

    effect(() => {
      this.activeModelKey();
      untracked(() => {
        this.editorSelectionChip.set(null);
      });
    });

    effect(() => {
      const wsId = this.currentWorkspaceId();
      untracked(() => {
        this.onWorkspaceIdChangedForOpenTabs(wsId);
      });
    });

    effect(() => {
      const layout = this.editorGrid();
      const focusedSlotId = this.focusedSlotId();
      untracked(() => {
        if (!this.openTabsHydrated || this.applyingRestoredOpenTabs) {
          return;
        }
        void this.persistOpenTabsNow(this.openTabsOwnedWorkspaceId, layout, focusedSlotId);
      });
    });

    // Keep the focused slot id valid when splits collapse.
    effect(() => {
      const layout = this.editorGrid();
      const focused = this.focusedSlotId();
      untracked(() => {
        const resolved = resolveFocusedSlotId(layout, focused);
        if (resolved !== focused) {
          this.focusedSlotId.set(resolved);
        }
      });
    });

    effect(() => {
      const unsaved = this.monacoStore.unsavedKeys();
      untracked(() => {
        this.electron.reportWorkspaceMonacoUnsavedPaths(
          [...unsaved].map((k) => relativePathFromModelKey(k) ?? k),
        );
      });
    });

    // Grid-wide model claim: keeps buffers (and their unsaved edits) alive while a tab moves
    // between slots or into a new split, independent of per-slot editor instance lifetimes.
    effect(() => {
      const refs = this.gridOpenEditorFiles();
      untracked(() => this.monacoStore.syncGridOpenFiles(refs));
    });

    this.monacoStore.saveAsCompleted$
      .pipe(takeUntilDestroyed())
      .subscribe((payload) => this.onMonacoSaveAsCompleted(payload));

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
      const previousWorkspaceId = this.currentWorkspaceId();
      this.applyIncomingAppConfig(config);
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
      applyAppFontOverrides(config);
      this.workspaces.set(config.workspaces);
      this.applyWorkspaceIdFromConfig(config, false);
      if (this.currentWorkspaceId() !== previousWorkspaceId) {
        void this.loadConversationsForWorkspace();
      }
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
    this.openTabsHydrated = true;
    this.applyWorkspaceIdFromConfig(config, true);
    this.restoreOpenTabsForWorkspace(this.currentWorkspaceId());

    applyAppFontOverrides(config);
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
    this.clearChromeRecentCloseTimer();
    this.stopLmStudioContextPoll();
    void this.ngxSpinner.hide(this.newConvExpandedSpinnerName);
    void this.tts.invalidateSpeechPipeline();
    window.removeEventListener('resize', this.boundOnWindowResize);
    this.flushSidebarWidthPersist();
    void this.persistOpenTabsNow(this.openTabsOwnedWorkspaceId, this.editorGrid(), this.focusedSlotId());
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

  /** Replace the grid with a single empty slot. */
  private resetEditorGrid(): void {
    const layout = singleSlotLayout();
    this.editorGrid.set(layout);
    this.focusedSlotId.set(firstSlotId(layout));
  }

  private onWorkspaceIdChangedForOpenTabs(workspaceId: string | null): void {
    if (!this.openTabsHydrated) {
      this.resetEditorGrid();
      this.clearChatContextFiles();
      return;
    }
    const prev = this.openTabsOwnedWorkspaceId;
    if (prev === workspaceId) {
      return;
    }
    if (prev) {
      void this.persistOpenTabsNow(prev, this.editorGrid(), this.focusedSlotId());
    }
    this.restoreOpenTabsForWorkspace(workspaceId);
    this.clearChatContextFiles();
  }

  private applyIncomingAppConfig(config: AppConfig): void {
    this.appConfig.set(
      retainRendererWorkspaceOpenTabs(config, this.appConfig()?.workspaceOpenTabsByWorkspaceId),
    );
  }

  private applyWorkspaceIdFromConfig(config: AppConfig, isStartup: boolean): void {
    this.defaultHomePageOnStart.set(config.defaultHomePageOnStart === true);
    if (isStartup) {
      const startupId = resolveStartupWorkspaceId(config);
      this.holdStartupHomePage = startupId === null && !!config.currentWorkspaceId;
      this.currentWorkspaceId.set(startupId);
      return;
    }
    if (this.holdStartupHomePage && config.currentWorkspaceId) {
      return;
    }
    this.currentWorkspaceId.set(config.currentWorkspaceId);
  }

  private acknowledgeSessionWorkspace(): void {
    this.holdStartupHomePage = false;
  }

  protected async onDefaultHomePageChange(checked: boolean): Promise<void> {
    this.defaultHomePageOnStart.set(checked);
    const config = this.appConfig();
    if (!config || config.defaultHomePageOnStart === checked) {
      return;
    }
    try {
      const saved = await this.electron.saveConfig({
        ...config,
        defaultHomePageOnStart: checked,
      });
      this.applyIncomingAppConfig(saved);
    } catch (err) {
      console.error('[App] persist defaultHomePageOnStart failed', err);
    }
  }

  private restoreOpenTabsForWorkspace(workspaceId: string | null): void {
    this.applyingRestoredOpenTabs = true;
    try {
      this.openTabsOwnedWorkspaceId = workspaceId;
      const key = workspaceId?.trim() || '';
      if (!key) {
        this.resetEditorGrid();
        this.lastPersistedOpenTabsJson = '';
        return;
      }
      const restored = editorGridLayoutFromPersistedState(
        this.appConfig()?.workspaceOpenTabsByWorkspaceId?.[key],
      );
      this.editorGrid.set(restored.layout);
      this.focusedSlotId.set(restored.focusedSlotId);
      this.lastPersistedOpenTabsJson = JSON.stringify(
        serializeEditorGridOpenTabs(restored.layout, restored.focusedSlotId),
      );
    } finally {
      this.applyingRestoredOpenTabs = false;
    }
  }

  private mergeOpenTabsIntoAppConfig(workspaceId: string, state: WorkspaceOpenTabsState): void {
    const config = this.appConfig();
    if (!config) {
      return;
    }
    const byWs = { ...(config.workspaceOpenTabsByWorkspaceId ?? {}) };
    if (state.tabs.length === 0) {
      delete byWs[workspaceId];
    } else {
      byWs[workspaceId] = state;
    }
    this.appConfig.set({ ...config, workspaceOpenTabsByWorkspaceId: byWs });
  }

  private async persistOpenTabsNow(
    workspaceId: string | null,
    layout: EditorGridLayout,
    focusedSlotId: string | null,
  ): Promise<void> {
    const key = workspaceId?.trim() || '';
    if (!key) {
      return;
    }
    const state = serializeEditorGridOpenTabs(layout, focusedSlotId);
    const json = JSON.stringify(state);
    if (workspaceId === this.openTabsOwnedWorkspaceId && json === this.lastPersistedOpenTabsJson) {
      return;
    }
    this.mergeOpenTabsIntoAppConfig(key, state);
    try {
      await this.electron.patchWorkspaceOpenTabs(key, state);
      if (workspaceId === this.openTabsOwnedWorkspaceId) {
        this.lastPersistedOpenTabsJson = json;
      }
    } catch (err) {
      console.error('[App] persist workspace open tabs failed', err);
    }
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
      this.applyIncomingAppConfig(saved);
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
      const workspaceNotes = this.conversationSession.takeWorkspaceNotes(convId);
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
        this.adminElevationGranted(),
        workspaceNotes,
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

  onAcceptCommandFinished(event: AcceptCommandFinishedEvent): void {
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
    if (acceptCommandGrantsAdminElevation(event)) {
      this.adminElevationGranted.set(true);
    }
  }

  onAdminGrantRequested(): void {
    const convId = this.activeConversationId();
    if (!convId || this.adminElevationGranted() || this.adminElevationPending()) {
      return;
    }
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.conversationSession.appendLocalHitlArtifact(convId, {
      role: 'accept_command',
      payload: createAdminElevationAcceptPayload(requestId),
      reviewStatus: 'pending',
    });
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

  /** Theme proposal card resolved (saved / applied / dismissed); no backend round-trip needed. */
  onThemeProposalFinished(event: ThemeProposalFinishedEvent): void {
    this.messages.update((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        const m = copy[i];
        if (
          m.role === 'theme_proposal' &&
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

  /** Confirm, then clear the current workspace so the welcome screen is shown. */
  private async closeCurrentWorkspace(): Promise<void> {
    if (!this.hasOpenWorkspace()) {
      return;
    }
    const choice = await this.themedConfirm.open(closeWorkspacePrompt(this.currentWorkspace()?.name));
    if (choice !== 'confirm') {
      return;
    }
    await this.onWorkspaceChanged(null);
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

    await this.persistOpenTabsNow(this.openTabsOwnedWorkspaceId, this.editorGrid(), this.focusedSlotId());
    await this.electron.setCurrentWorkspace(workspaceId);
    this.acknowledgeSessionWorkspace();
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

  protected async onToggleWorkspaceFavorite(workspaceId: string): Promise<void> {
    const current = this.workspaces().find((workspace) => workspace.id === workspaceId);
    if (!current) {
      return;
    }
    const nextFavorite = !current.favorite;
    const saved = await this.electron.setWorkspaceFavorite(workspaceId, nextFavorite);
    this.workspaces.set(
      saved?.workspaces ?? setWorkspaceFavorite(this.workspaces(), workspaceId, nextFavorite),
    );
  }

  protected async onReorderWorkspaceFavorites(orderedIds: string[]): Promise<void> {
    const saved = await this.electron.reorderWorkspaceFavorites(orderedIds);
    this.workspaces.set(
      saved?.workspaces ?? reorderFavoriteWorkspaces(this.workspaces(), orderedIds),
    );
  }

  /**
   * Open (or focus) a read-only diff tab for one file a past turn edited, with the before /
   * after text from main's turn-file snapshot. Modeled on {@link openOrFocusFileTab}.
   */
  protected async openTurnDiffTab(req: TurnDiffOpenRequest): Promise<void> {
    const convId = this.activeConversationId();
    const root = this.currentWorkspacePath().trim();
    const norm = normalizePathSlashes(req.relativePath);
    if (!convId || !root || !norm || !req.userMessageId) {
      return;
    }
    const tab = turnDiffChatFileTab({ userMessageId: req.userMessageId, relativePath: norm, turnNumber: req.turnNumber });
    const id = chatFileTabId(tab);

    const res = await this.electron.getTurnFileDiff(convId, req.userMessageId, norm);
    if (!res.ok) {
      console.error('[App] get-turn-file-diff failed:', res.error);
      return;
    }
    this.turnDiffContents.update((prev) => {
      const next = new Map(prev);
      next.set(id, {
        modelKey: id,
        relativePath: norm,
        label: `Turn ${req.turnNumber}`,
        original: res.before,
        modified: res.after,
      });
      return next;
    });

    const focusedId = this.ensureFocusedSlotId();
    const layout = this.editorGrid();
    const focusedSlot = slotById(layout, focusedId);
    if (focusedSlot?.tabs.some((t) => chatFileTabId(t) === id)) {
      this.editorGrid.set(setActiveTab(layout, focusedId, id));
    } else {
      const elsewhere = slotIdsContainingModelKey(layout, id)[0];
      if (elsewhere) {
        this.focusedSlotId.set(elsewhere);
        this.editorGrid.set(setActiveTab(layout, elsewhere, id));
      } else {
        this.editorGrid.set(addTabToSlot(layout, focusedId, tab));
      }
    }
    this.chatExpanded.set(false);
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

    const focusedId = this.ensureFocusedSlotId();

    // Same-folder images share one gallery tab (swap path) instead of stacking tabs.
    const imagePlan = planOpenWorkspaceImageTab(this.fileTabs(), norm, this.activeMainTabId());
    if (imagePlan?.action === 'focus') {
      this.editorGrid.update((layout) => setActiveTab(layout, focusedId, imagePlan.tabId));
      this.chatExpanded.set(false);
      return;
    }
    if (imagePlan?.action === 'retarget') {
      const newTabId = chatFileTabId({ relativePath: imagePlan.newRelativePath, outsideWorkspace: false });
      this.updateFocusedSlotTabs(
        (tabs) => retargetFileTabPath(tabs, imagePlan.oldRelativePath, imagePlan.newRelativePath),
        newTabId,
      );
      this.chatExpanded.set(false);
      return;
    }

    const tab = workspaceChatFileTab(norm);
    const id = chatFileTabId(tab);
    const key = chatFileTabModelKey(tab);
    const layout = this.editorGrid();
    const focusedSlot = slotById(layout, focusedId);
    if (focusedSlot?.tabs.some((t) => chatFileTabModelKey(t) === key)) {
      this.editorGrid.set(setActiveTab(layout, focusedId, id));
    } else {
      // Already open elsewhere in the grid: focus that slot instead of duplicating.
      const elsewhere = slotIdsContainingModelKey(layout, key)[0];
      if (elsewhere) {
        this.focusedSlotId.set(elsewhere);
        this.editorGrid.set(setActiveTab(layout, elsewhere, id));
      } else {
        this.editorGrid.set(addTabToSlot(layout, focusedId, tab));
      }
    }
    // Opening a file in the workspace Monaco editor collapses the expanded chat
    // overlay so the editor is actually visible.
    this.chatExpanded.set(false);
  }

  /** Focused slot id, repaired to the first slot when stale. */
  private ensureFocusedSlotId(): string {
    const layout = this.editorGrid();
    const resolved = resolveFocusedSlotId(layout, this.focusedSlotId()) ?? firstSlotId(layout)!;
    if (resolved !== this.focusedSlotId()) {
      this.focusedSlotId.set(resolved);
    }
    return resolved;
  }

  /** Rewrite the focused slot's tab list; `activeTabId` (when given) becomes active. */
  private updateFocusedSlotTabs(
    fn: (tabs: readonly ChatFileTab[]) => ChatFileTab[],
    activeTabId?: string | null,
  ): void {
    const focusedId = this.ensureFocusedSlotId();
    this.editorGrid.update((layout) => ({
      ...layout,
      columns: layout.columns.map((c) => ({
        ...c,
        slots: c.slots.map((s) => {
          if (s.id !== focusedId) {
            return s;
          }
          const tabs = fn(s.tabs);
          const wanted = activeTabId === undefined ? s.activeTabId : activeTabId;
          const active =
            wanted && tabs.some((t) => chatFileTabId(t) === wanted)
              ? wanted
              : tabs.length > 0
                ? chatFileTabId(tabs[tabs.length - 1]!)
                : null;
          return { ...s, tabs, activeTabId: active };
        }),
      })),
    }));
  }

  /** Grid: pointer focus moved to another slot. */
  protected onEditorGridSlotFocus(slotId: string): void {
    if (this.focusedSlotId() !== slotId && slotById(this.editorGrid(), slotId)) {
      this.focusedSlotId.set(slotId);
    }
  }

  protected onEditorGridLayoutChange(layout: EditorGridLayout): void {
    this.editorGrid.set(layout);
  }

  protected onEditorGridTabSelect(ev: { slotId: string; tabId: string }): void {
    this.focusedSlotId.set(ev.slotId);
    this.editorGrid.update((layout) => setActiveTab(layout, ev.slotId, ev.tabId));
    if (ev.tabId.startsWith('file:') || isTurnDiffModelKey(ev.tabId)) {
      this.chatExpanded.set(false);
    }
  }

  protected async onEditorGridTabClose(ev: { slotId: string; tabId: string }): Promise<void> {
    await this.tryCloseFileTabById(ev.tabId, ev.slotId);
  }

  /**
   * Grid: a workspace file was dragged from the nav tree onto a slot. Edge drops split the
   * slot and open the file in the new one; center drops open it in the target slot.
   */
  protected onEditorGridFileDrop(ev: EditorGridFileDrop): void {
    const root = this.currentWorkspacePath().trim();
    if (!root) {
      return;
    }
    const rel = workspaceRelativePathIfUnderRoot(root, ev.absolutePath);
    if (rel === null || rel === '') {
      return;
    }
    const layout = this.editorGrid();
    if (!slotById(layout, ev.slotId)) {
      return;
    }
    const tab = workspaceChatFileTab(rel);
    if (ev.side) {
      const res = splitSlotWithNewTab(layout, ev.slotId, ev.side, tab);
      if (res.newSlotId) {
        this.editorGrid.set(res.layout);
        this.focusedSlotId.set(res.newSlotId);
        this.chatExpanded.set(false);
        return;
      }
    }
    this.focusedSlotId.set(ev.slotId);
    this.editorGrid.set(addTabToSlot(layout, ev.slotId, tab));
    this.chatExpanded.set(false);
  }

  protected onEditorGridTabContextMenu(ev: { slotId: string; tabId: string; x: number; y: number }): void {
    this.closeChromeMenu();
    this.fileTabContextMenuSlotId.set(ev.slotId);
    this.fileTabContextMenuTabId.set(ev.tabId);
    this.fileTabContextMenuX.set(ev.x);
    this.fileTabContextMenuY.set(ev.y);
    this.fileTabContextMenuVisible.set(true);
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
    const layout = this.editorGrid();
    const all = this.allFileTabs();
    const byPlan = all.find((t) => t.buildPlanId === planId);
    if (byPlan) {
      const oldTabId = chatFileTabId(byPlan);
      const updatedTab: ChatFileTab = { ...byPlan, relativePath: norm, buildPlanActive: active, previewOnly: true };
      const newTabId = chatFileTabId(updatedTab);
      const next = updateTabsEverywhere(
        layout,
        (tabs) => tabs.map((t) => (t.buildPlanId === planId ? { ...t, ...updatedTab } : t)),
        { oldTabId, newTabId },
      );
      this.focusTabEverywhere(next, newTabId);
      return;
    }
    const byPath = all.find((t) => !t.outsideWorkspace && normalizePathSlashes(t.relativePath ?? '') === norm);
    if (byPath) {
      const tabId = chatFileTabId(byPath);
      const next = updateTabsEverywhere(layout, (tabs) =>
        tabs.map((t) =>
          !t.outsideWorkspace && normalizePathSlashes(t.relativePath ?? '') === norm
            ? { ...t, buildPlanId: planId, buildPlanActive: active, previewOnly: true }
            : t,
        ),
      );
      this.focusTabEverywhere(next, tabId);
      return;
    }
    const tab = buildPlanChatFileTab(norm, planId, active);
    const focusedId = this.ensureFocusedSlotId();
    this.editorGrid.set(addTabToSlot(layout, focusedId, tab));
  }

  /** Commit `layout`, then activate `tabId` in the focused slot if it has it, else in the first slot that does. */
  private focusTabEverywhere(layout: EditorGridLayout, tabId: string): void {
    const focusedId = resolveFocusedSlotId(layout, this.focusedSlotId());
    const holders = slotIdsContainingTabId(layout, tabId);
    const target = focusedId && holders.includes(focusedId) ? focusedId : holders[0];
    if (!target) {
      this.editorGrid.set(layout);
      return;
    }
    this.focusedSlotId.set(target);
    this.editorGrid.set(setActiveTab(layout, target, tabId));
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
    this.editorGrid.update((layout) => updateTabsEverywhere(layout, (tabs) => deactivateBuildPlanTab(tabs, id)));
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
    const tabToClose = this.allFileTabs().find((t) => t.buildPlanId === id);
    if (!tabToClose) {
      return;
    }
    this.editorGrid.update((layout) => removeTabEverywhere(layout, chatFileTabModelKey(tabToClose)));
  }

  private closeFileTabContextMenu(): void {
    this.fileTabContextMenuVisible.set(false);
    this.fileTabContextMenuTabId.set(null);
    this.fileTabContextMenuSlotId.set(null);
  }

  private chromeRecentCloseTimer: ReturnType<typeof setTimeout> | null = null;

  private clearChromeRecentCloseTimer(): void {
    if (this.chromeRecentCloseTimer !== null) {
      clearTimeout(this.chromeRecentCloseTimer);
      this.chromeRecentCloseTimer = null;
    }
  }

  private closeChromeMenu(): void {
    this.clearChromeRecentCloseTimer();
    this.chromeMenu.set(null);
  }

  private placeChromeRecentSubmenu(anchor: DOMRect): void {
    const submenuWidth = 14 * 16;
    const pad = 8;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    let x = Math.floor(anchor.right) - 1;
    let y = Math.floor(anchor.top);
    if (x + submenuWidth > vw - pad) {
      x = Math.floor(anchor.left) - submenuWidth + 1;
    }
    x = Math.max(pad, Math.min(x, vw - submenuWidth - pad));
    y = Math.max(pad, Math.min(y, vh - pad - 40));
    this.chromeRecentMenuX.set(x);
    this.chromeRecentMenuY.set(y);
  }

  private openChromeMenu(kind: 'settings' | 'file', ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.closeFileTabContextMenu();
    const current = this.chromeMenu();
    const alreadyOpen = current === kind || (kind === 'file' && current === 'file-recent');
    if (alreadyOpen) {
      this.closeChromeMenu();
      return;
    }
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    this.chromeMenuX.set(Math.floor(r.left));
    this.chromeMenuY.set(Math.floor(r.bottom) + 2);
    this.chromeMenu.set(kind);
  }

  protected onChromeFileMenu(ev: MouseEvent): void {
    this.openChromeMenu('file', ev);
  }

  protected onChromeSettingsMenu(ev: MouseEvent): void {
    this.openChromeMenu('settings', ev);
  }

  protected onChromeOpenRecentEnter(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.clearChromeRecentCloseTimer();
    const el = ev.currentTarget as HTMLElement;
    this.placeChromeRecentSubmenu(el.getBoundingClientRect());
    this.chromeMenu.set('file-recent');
  }

  protected onChromeRecentSubmenuEnter(): void {
    this.clearChromeRecentCloseTimer();
    this.chromeMenu.set('file-recent');
  }

  protected onChromeFileItemEnter(): void {
    if (this.chromeMenu() !== 'file-recent') {
      return;
    }
    this.clearChromeRecentCloseTimer();
    this.chromeRecentCloseTimer = setTimeout(() => {
      this.chromeRecentCloseTimer = null;
      if (this.chromeMenu() === 'file-recent') {
        this.chromeMenu.set('file');
      }
    }, 150);
  }

  protected onChromeOpenFolder(): void {
    this.closeChromeMenu();
    void this.onAddWorkspace();
  }

  protected onChromeOpenRecentWorkspace(workspaceId: string): void {
    this.closeChromeMenu();
    void this.onWorkspaceChanged(workspaceId);
  }

  protected onChromeCloseWorkspace(): void {
    this.closeChromeMenu();
    void this.closeCurrentWorkspace();
  }

  protected onChromeNewFile(): void {
    this.closeChromeMenu();
    if (!this.hasOpenWorkspace()) {
      return;
    }
    this.workspacePanel?.beginCreateFromMenu('file');
  }

  protected onChromeNewFolder(): void {
    this.closeChromeMenu();
    if (!this.hasOpenWorkspace()) {
      return;
    }
    this.workspacePanel?.beginCreateFromMenu('folder');
  }

  protected onChromeNewAgent(): void {
    this.closeChromeMenu();
    if (!this.hasOpenWorkspace()) {
      return;
    }
    void this.onNewConversation();
  }

  protected onChromeNewTerminal(): void {
    this.closeChromeMenu();
    if (!this.hasOpenWorkspace()) {
      return;
    }
    this.workspaceTerminalDock?.openNewTerminal();
  }

  protected onChromeExit(): void {
    this.closeChromeMenu();
    this.electron.appQuit();
  }

  private onMenuFileCommand(command: MenuFileCommand): void {
    switch (command.action) {
      case 'open-folder':
        void this.onAddWorkspace();
        break;
      case 'open-recent':
        if (command.workspaceId) {
          void this.onWorkspaceChanged(command.workspaceId);
        }
        break;
      case 'close-workspace':
        void this.closeCurrentWorkspace();
        break;
      case 'new-file':
        if (!this.hasOpenWorkspace()) {
          return;
        }
        this.workspacePanel?.beginCreateFromMenu('file');
        break;
      case 'new-folder':
        if (!this.hasOpenWorkspace()) {
          return;
        }
        this.workspacePanel?.beginCreateFromMenu('folder');
        break;
      case 'new-agent':
        if (!this.hasOpenWorkspace()) {
          return;
        }
        void this.onNewConversation();
        break;
      case 'new-terminal':
        if (!this.hasOpenWorkspace()) {
          return;
        }
        this.workspaceTerminalDock?.openNewTerminal();
        break;
      case 'exit':
        this.electron.appQuit();
        break;
      default:
        break;
    }
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

  /** @param slotId slot the close came from; defaults to the focused slot. */
  private async tryCloseFileTabById(tabId: string, slotId?: string): Promise<boolean> {
    if (isTurnDiffModelKey(tabId)) {
      this.removeFileTabByModelKey(tabId, slotId);
      if (!slotIdsContainingModelKey(this.editorGrid(), tabId).length) {
        this.turnDiffContents.update((prev) => {
          const next = new Map(prev);
          next.delete(tabId);
          return next;
        });
      }
      return true;
    }
    if (!tabId.startsWith('file:')) {
      return false;
    }
    return this.tryCloseFileTabByModelKey(tabId.slice(5), slotId);
  }

  private async tryCloseFileTabByModelKey(modelKey: string, slotId?: string): Promise<boolean> {
    let keyToClose = modelKey;
    const layout = this.editorGrid();
    const targetSlotId = slotId ?? this.ensureFocusedSlotId();
    const holders = slotIdsContainingModelKey(layout, modelKey);
    // The file stays open in another slot: just drop this slot's tab, no prompts.
    if (holders.length > 1 && holders.includes(targetSlotId)) {
      this.removeFileTabByModelKey(modelKey, targetSlotId);
      return true;
    }
    const tab = findTabByModelKey(this.allFileTabs(), modelKey);
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
      this.removeFileTabByModelKey(keyToClose, targetSlotId);
      return true;
    }

    if (detached && unsaved) {
      const choice = await this.themedConfirm.open(detachedFileClosePrompt(displayPath));
      if (choice === 'cancel') {
        return false;
      }
      if (choice === 'middle') {
        const newKey = await this.monacoStore.promptSaveAs(modelKey);
        if (!newKey) {
          return false;
        }
        keyToClose = newKey;
      } else if (choice === 'confirm') {
        await this.monacoStore.cleanupDetachedForKey(modelKey);
      }
    } else if (unsaved) {
      const discard = await this.themedConfirm.open(unsavedCloseFileTabPrompt(displayPath));
      if (discard !== 'confirm') {
        return false;
      }
    } else if (detached) {
      await this.monacoStore.cleanupDetachedForKey(modelKey);
    }

    this.removeFileTabByModelKey(keyToClose, targetSlotId);
    return true;
  }

  private async closeFileTabsInOrder(tabIds: readonly string[], slotId?: string): Promise<void> {
    for (const tabId of tabIds) {
      const closed = await this.tryCloseFileTabById(tabId, slotId);
      if (!closed) {
        break;
      }
    }
  }

  /** Remove a tab from one slot (default: focused); collapses emptied slots / columns. */
  private removeFileTabByModelKey(keyToClose: string, slotId?: string): void {
    const targetSlotId = slotId ?? this.ensureFocusedSlotId();
    this.editorGrid.update((layout) => removeTabFromSlot(layout, targetSlotId, keyToClose));
  }

  private applyFileRenamedTabs(oldRelativePath: string, newRelativePath: string): void {
    const oldTabId = chatFileTabId({ relativePath: oldRelativePath, outsideWorkspace: false });
    const newTabId = chatFileTabId({ relativePath: newRelativePath, outsideWorkspace: false });
    const layout = this.editorGrid();
    if (slotIdsContainingTabId(layout, oldTabId).length === 0) {
      return;
    }
    this.editorGrid.set(
      updateTabsEverywhere(
        layout,
        (tabs) => openTabForRenamedFile(tabs, oldRelativePath, newRelativePath).tabs,
        { oldTabId, newTabId },
      ),
    );
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

    for (const tab of this.allFileTabs()) {
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

  private onMonacoSaveAsCompleted(payload: WorkspaceMonacoSaveAsResult): void {
    const oldKey = payload.oldModelKey;
    this.editorGrid.update((layout) =>
      updateTabsEverywhere(
        layout,
        (tabs) =>
          replaceFileTabAfterSaveAs(tabs, oldKey, {
            relativePath: payload.relativePath,
            absolutePath: payload.absolutePath,
            outsideWorkspace: payload.outsideWorkspace,
          }),
        { oldTabId: `file:${oldKey}`, newTabId: `file:${payload.newModelKey}` },
      ),
    );
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

  /** The `app-workspace-monaco` instance rendered in the focused grid slot. */
  private focusedWorkspaceMonaco(): WorkspaceMonacoComponent | undefined {
    const list = this.workspaceMonacos?.toArray() ?? [];
    return list.find((m) => m.focused()) ?? list[0];
  }

  protected onRevealEditorDiagnostic(d: LspEditorDiagnostic): void {
    this.focusedWorkspaceMonaco()?.revealDiagnostic(d);
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
    this.updateFocusedSlotTabs(
      (tabs) => retargetFileTabPath(tabs, oldPath, newPath),
      chatFileTabId({ relativePath: newPath, outsideWorkspace: false }),
    );
  }

  protected onMonacoRevealHandled(): void {
    this.monacoRevealPending.set(null);
  }

  /** Activate a tab in the focused slot (keyboard / programmatic selection). */
  protected selectMainTab(tabId: string): void {
    const focusedId = this.ensureFocusedSlotId();
    this.editorGrid.update((layout) => setActiveTab(layout, focusedId, tabId));
    if (tabId.startsWith('file:') || isTurnDiffModelKey(tabId)) {
      // Focusing an editor file tab collapses the expanded chat overlay so the
      // selected file is actually visible.
      this.chatExpanded.set(false);
    }
  }

  protected onFileTabContextMenuItemMousedown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  protected async onFileTabContextMenuClose(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    const slotId = this.fileTabContextMenuSlotId() ?? undefined;
    this.closeFileTabContextMenu();
    if (tabId) {
      await this.tryCloseFileTabById(tabId, slotId);
    }
  }

  protected async onFileTabContextMenuCloseAll(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    const slotId = this.fileTabContextMenuSlotId() ?? undefined;
    const tabs = this.fileTabContextMenuTabs();
    this.closeFileTabContextMenu();
    if (!tabId) {
      return;
    }
    const tabIds = [...allFileTabIds(tabs)].reverse();
    await this.closeFileTabsInOrder(tabIds, slotId);
  }

  protected async onFileTabContextMenuCloseLeft(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    const slotId = this.fileTabContextMenuSlotId() ?? undefined;
    const tabs = this.fileTabContextMenuTabs();
    this.closeFileTabContextMenu();
    if (!tabId) {
      return;
    }
    const tabIds = [...fileTabIdsToLeft(tabs, tabId)].reverse();
    await this.closeFileTabsInOrder(tabIds, slotId);
  }

  protected async onFileTabContextMenuCloseRight(): Promise<void> {
    const tabId = this.fileTabContextMenuTabId();
    const slotId = this.fileTabContextMenuSlotId() ?? undefined;
    const tabs = this.fileTabContextMenuTabs();
    this.closeFileTabContextMenu();
    if (!tabId) {
      return;
    }
    const tabIds = [...fileTabIdsToRight(tabs, tabId)].reverse();
    await this.closeFileTabsInOrder(tabIds, slotId);
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
    this.focusedWorkspaceMonaco()?.openFindWidget();
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

  protected fileTabIsUnsaved(modelKey: string): boolean {
    return this.monacoUnsavedPaths().has(modelKey);
  }

  protected fileTabIsDetached(modelKey: string): boolean {
    return this.monacoDetachedPaths().has(modelKey);
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
      await this.persistOpenTabsNow(this.openTabsOwnedWorkspaceId, this.editorGrid(), this.focusedSlotId());
      await this.electron.setCurrentWorkspace(conv.workspaceId);
      const config = await this.electron.loadConfig();
      this.workspaces.set(config.workspaces);
      this.acknowledgeSessionWorkspace();
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
