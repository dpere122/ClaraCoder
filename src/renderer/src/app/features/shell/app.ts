/**
 * Main chat shell: conversations, workspace chrome, IPC-driven streaming, and layout resize handles.
 * TTS playback lives in {@link TtsPlaybackService}; this component wires signals and `ElectronService` streams.
 */
import { Component, computed, effect, model, NgZone, OnDestroy, OnInit, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  Conversation,
  ConversationMeta,
  FileDiffPayload,
  LlmStatus,
  StreamPart,
  Workspace,
} from '@shared/index';
import {
  DEFAULT_KOKORO_TTS_VOICE,
  findLlmModelLocation,
  primaryAssistantTextFromParts,
  READ_TOOL_PREVIEW_STREAM_TAG,
  resolveActiveLlmConnection,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  TTS_SPEECH_SPEED_DEFAULT,
  TTS_SPEECH_SPEED_MAX,
  TTS_SPEECH_SPEED_MIN,
} from '@shared/index';
import { ChatBox, ChatMessage } from '../chat/chat-box/chat-box';
import { buildAssistantTurnFromStreamParts } from './app-assistant-turn';
import {
  chatFileTabBasename,
  chatFileTabId,
  readLlamaServerDockFromStorage,
  writeLlamaServerDockToStorage,
  type ChatFileTab,
  type LlamaServerDockSide,
} from './app-chat-file-tabs';
import {
  appendStreamPart,
  markToolExecStreamComplete,
  upsertToolTrailStatusStreamPart,
} from './app-stream-parts';
import { applyAppTheme, resolveAppThemeId } from './app-theme';
import { MessageBox } from '../chat/message-box/message-box';
import { ConversationManager } from '../chat/conversation-manager/conversation-manager';
import { LlamaServerTile } from '../chat/llama-server-tile/llama-server-tile';
import { TalkMode } from '../speech/talk-mode/talk-mode';
import { buildContextCapacitySnapshot } from '../status/context-capacity/context-capacity.utils';
import { StatusBarComponent } from '../status/status-bar/status-bar';
import { WorkspaceComponent } from '../workspace/workspace/workspace';
import { WorkspaceMonacoComponent } from '../workspace/workspace-monaco/workspace-monaco';
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
} from '../../shared/themed-confirm-dialog/format-unsaved-workspace-detail';
import { normalizePathSlashes, workspaceRelativePathIfUnderRoot } from '../../utils/workspace-relative-path';
import { LucideAngularModule } from 'lucide-angular';

@Component({
  selector: 'app-root',
  imports: [
    ChatBox,
    MessageBox,
    ConversationManager,
    LlamaServerTile,
    TalkMode,
    LucideAngularModule,
    WorkspaceComponent,
    WorkspaceMonacoComponent,
    WorkspaceTerminalDockComponent,
    StatusBarComponent,
    ThemedConfirmDialogComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
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
  protected readonly streamingParts = signal<StreamPart[]>([]);
  /**
   * Prompt token count from the last completed chat-model step (OpenAI-compatible ``usage`` /
   * LangChain ``usage_metadata``). Cleared when switching conversations; overrides heuristic estimates.
   */
  protected readonly measuredPromptTokens = signal<number | null>(null);
  protected readonly settingsWindowOpen = signal(false);
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
  /** Relative paths with unsaved Monaco buffers (mirrors main process for workspace-switch confirm). */
  protected readonly monacoUnsavedPaths = signal<ReadonlySet<string>>(new Set());
  /** One-shot scroll target after cross-file go-to-definition from Monaco. */
  protected readonly monacoRevealPending = signal<{
    relativePath: string;
    line: number;
    column: number;
  } | null>(null);
  /** `conversation` or `file:<relativePath>`. */
  protected readonly activeMainTabId = signal<string>('conversation');

  protected readonly conversationTabTitle = computed(() => {
    const id = this.activeConversationId();
    if (!id) {
      return 'Chat';
    }
    const t = this.conversations().find((c) => c.id === id)?.title?.trim();
    return t || 'Chat';
  });

  protected readonly openFileRelativePaths = computed(() => this.fileTabs().map((t) => t.relativePath));

  protected readonly activeFileRelativePath = computed(() => {
    const tabId = this.activeMainTabId();
    if (!tabId.startsWith('file:')) {
      return null;
    }
    return tabId.slice(5);
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
      if (m.role === 'diff' && (m.reviewStatus ?? 'pending') === 'pending') {
        if (normalizePathSlashes(m.payload.relativePath) === norm) {
          return m.payload;
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
    measuredPromptTokens: this.measuredPromptTokens(),
  }));

  /** Flattened model presets for the status-bar selector (under the message box). */
  protected readonly llmModelPresetOptions = computed(() => {
    const c = this.appConfig();
    if (!c?.llmProviders?.length) {
      return [] as Array<{ id: string; label: string }>;
    }
    const opts: Array<{ id: string; label: string }> = [];
    for (const p of c.llmProviders) {
      for (const m of p.models) {
        opts.push({ id: m.id, label: `${p.name} · ${m.name}` });
      }
    }
    return opts;
  });

  /** Same naming as Settings → Models “Sources”: source display name + preset label (not API model id). */
  protected readonly activeLlmModelDisplayName = computed(() => {
    const c = this.appConfig();
    if (!c?.llmProviders?.length) {
      return 'No active model';
    }
    const loc = findLlmModelLocation(c.llmProviders, c.activeLlmModelId);
    if (!loc) {
      return 'No active model';
    }
    return `${loc.provider.name} · ${loc.model.name}`;
  });

  // Layout
  protected readonly workspaceWidth = signal(220);
  protected readonly sidebarWidth = signal(220);
  /** Where the managed llama.cpp status tile is docked (persisted in localStorage). */
  protected readonly llamaServerDock = signal<LlamaServerDockSide>(readLlamaServerDockFromStorage());

  private static readonly MIN_WORKSPACE = 140;
  private static readonly MAX_WORKSPACE = 500;
  private static readonly MIN_SIDEBAR = 140;
  private static readonly MAX_SIDEBAR = 500;

  private activeConversation: Conversation | null = null;
  private backgroundStreamParts = new Map<string, StreamPart[]>();
  /** Final assistant text from backend (clean, without briefs) per conversation. */
  private pendingFinalText = new Map<string, string>();
  private resizing: 'workspace' | 'sidebar' | null = null;
  private boundOnResizeMove = this.onResizeMove.bind(this);
  private boundOnResizeEnd = this.onResizeEnd.bind(this);
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
      this.currentWorkspaceId();
      untracked(() => {
        this.fileTabs.set([]);
        this.activeMainTabId.set('conversation');
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
      this.measuredPromptTokens.set(null);
    });

    effect(() => {
      this.activeConversationId();
      untracked(() => this.pendingDiffReview.clearAllSessions());
    });

    this.electron.llmTokenUsage$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, inputTokens }) => {
      if (conversationId !== this.activeConversationId()) return;
      if (inputTokens > 0) {
        this.measuredPromptTokens.set(inputTokens);
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
      // Resolve theme: workspace theme > noWorkspaceThemeId > dark
      applyAppTheme(resolveAppThemeId(config));
      this.workspaces.set(config.workspaces);
      this.currentWorkspaceId.set(config.currentWorkspaceId);
    });

    this.electron.settingsWindowVisibility$.pipe(takeUntilDestroyed()).subscribe((isOpen) => {
      this.settingsWindowOpen.set(isOpen);
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
      const label = 'File read preview';
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) =>
          appendStreamPart(prev, READ_TOOL_PREVIEW_STREAM_TAG, delta, label),
        );
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(
          conversationId,
          appendStreamPart(prev, READ_TOOL_PREVIEW_STREAM_TAG, delta, label),
        );
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
      if (conversationId !== this.activeConversationId()) return;
      if (diff.version !== 1 || !Array.isArray(diff.rows)) return;
      this.messages.update((prev) => [
        ...prev,
        { role: 'diff', payload: diff, reviewStatus: 'pending' as const },
      ]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.acceptCommand$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (conversationId !== this.activeConversationId()) return;
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      this.messages.update((prev) => [
        ...prev,
        { role: 'accept_command', payload, reviewStatus: 'pending' as const },
      ]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.copyConfirm$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (conversationId !== this.activeConversationId()) return;
      if (payload.version !== 1 || !payload.requestId || !Array.isArray(payload.copies) || payload.copies.length === 0) return;
      this.messages.update((prev) => [
        ...prev,
        { role: 'copy_confirm', payload, reviewStatus: 'pending' as const },
      ]);
      if (this.activeConversation) {
        this.activeConversation.messages = [...this.messages()];
        this.pendingSave = true;
      }
    });

    this.electron.deleteConfirm$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, payload }) => {
      if (conversationId !== this.activeConversationId()) return;
      if (payload.version !== 1 || !payload.requestId) return;
      const batchOk = Array.isArray(payload.entries) && payload.entries.length > 0;
      const singleOk = typeof payload.relativePath === 'string' && payload.relativePath.trim().length > 0;
      if (!batchOk && !singleOk) return;
      this.messages.update((prev) => [
        ...prev,
        { role: 'delete_confirm', payload, reviewStatus: 'pending' as const },
      ]);
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
      }
      if (src === 'tool' && status.state === 'running') {
        this.toolRunIds.update((s) => new Set(s).add(status.id));
        this.streamingParts.update((prev) => upsertToolTrailStatusStreamPart(prev, status));
        this.upsertChainMessage(status);
        return;
      }
      if (src === 'tool' && (status.state === 'complete' || status.state === 'error')) {
        this.toolRunIds.update((s) => {
          const next = new Set(s);
          next.delete(status.id);
          return next;
        });
      }
      if (src === 'tool') {
        this.streamingParts.update((prev) => upsertToolTrailStatusStreamPart(prev, status));
      }
      this.upsertChainMessage(status);
    });

    this.electron.finalText$.pipe(takeUntilDestroyed()).subscribe(({ conversationId, text }) => {
      this.pendingFinalText.set(conversationId, text);
    });

    this.electron.done$.pipe(takeUntilDestroyed()).subscribe(({ conversationId }) => {
      this.removePending(conversationId);
      const parts =
        conversationId === this.activeConversationId()
          ? this.streamingParts()
          : (this.backgroundStreamParts.get(conversationId) ?? []);
      const turn = buildAssistantTurnFromStreamParts(parts, this.pendingFinalText.get(conversationId));
      this.pendingFinalText.delete(conversationId);

      if (conversationId === this.activeConversationId()) {
        this.toolRunIds.set(new Set());
        this.toolPhaseEngaged.set(false);
        this.streamingParts.set([]);
        if (turn) {
          this.pushMessage(
            'assistant',
            turn.text,
            turn.toolStreams,
            turn.moeStreams,
            turn.auxiliaryStreamTimeline,
          );
          if (this.speechEnabled() && turn.text.trim()) {
            void this.tts.flushStreamingAssistantText(turn.text, this.selectedVoice(), this.ttsSpeechSpeed());
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
            turn.moeStreams,
            turn.auxiliaryStreamTimeline,
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

    // Resolve theme: workspace theme > noWorkspaceThemeId > dark
    applyAppTheme(resolveAppThemeId(config));

    if (this.electron.isElectron) {
      this.windowMaximized.set(await this.electron.windowIsMaximized());
    }

    // Load conversations for current workspace
    await this.loadConversationsForWorkspace();
  }

  ngOnDestroy(): void {
    this.tts.invalidateSpeechPipeline();
    this.onResizeEnd();
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

  onMessageSent(text: string): void {
    const convId = this.activeConversationId();
    if (!convId) return;
    const normalized = text.trim();
    if (!normalized || this.pendingIds().has(convId)) return;
    this.pushMessage('user', normalized);
    this.addPending(convId);
    this.toolPhaseEngaged.set(false);
    if (this.speechEnabled()) {
      this.tts.beginAssistantSpeechTurn();
    }
    this.streamingParts.set([]);
    const workspaceId = this.activeConversation?.workspaceId ?? this.currentWorkspaceId();
    this.electron.sendMessage(
      convId,
      normalized,
      this.editorMode(),
      this.editorMode() && this.autoApplyMode(),
      undefined,
      workspaceId,
    );
    this.autoSave();
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
    // Resolve theme: workspace theme > noWorkspaceThemeId > dark
    const config = await this.electron.loadConfig();
    applyAppTheme(resolveAppThemeId(config, workspaceId));
    await this.refreshConversationList();
    void this.rememberLastActiveForWorkspace(conv);
  }

  onAbortRequested(): void {
    const convId = this.activeConversationId();
    if (!convId || !this.pendingIds().has(convId)) return;
    void this.electron.abortMessage(convId);
  }

  onSendResponse(text: string): void {
    // Send the output as a new user message
    this.onMessageSent(text);
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

  async onSelectConversation(id: string): Promise<void> {
    if (id === this.activeConversationId()) return;
    console.log('[App] onSelectConversation:', id);
    await this.saveCurrentConversation();
    // Use the conversation's own workspaceId
    const conv = this.conversations().find(c => c.id === id);
    const convWorkspaceId = conv?.workspaceId ?? this.currentWorkspaceId();
    console.log('[App] onSelectConversation: convWorkspaceId:', convWorkspaceId);
    await this.loadConversation(id, convWorkspaceId);
  }

  async onDeleteConversation(id: string): Promise<void> {
    // Use the conversation's own workspaceId to delete
    const conv = this.conversations().find(c => c.id === id);
    const convWorkspaceId = conv?.workspaceId ?? this.currentWorkspaceId();
    await this.electron.deleteConversation(id, convWorkspaceId);
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

  onLlamaServerDockChange(target: LlamaServerDockSide): void {
    if (target !== 'conversations' && target !== 'workspace') {
      return;
    }
    this.llamaServerDock.set(target);
    writeLlamaServerDockToStorage(target);
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
    this.resizing = null;
    document.body.classList.remove('workspace-resizing');
    document.body.classList.remove('sidebar-resizing');
    window.removeEventListener('mousemove', this.boundOnResizeMove);
    window.removeEventListener('mouseup', this.boundOnResizeEnd);
  }

  protected async onActiveLlmModelChange(modelId: string): Promise<void> {
    const config = await this.electron.loadConfig();
    if (!modelId || modelId === config.activeLlmModelId) {
      return;
    }
    if (!findLlmModelLocation(config.llmProviders, modelId)) {
      return;
    }
    await this.electron.saveConfig({ ...config, activeLlmModelId: modelId });
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
    const id = chatFileTabId(norm);
    const tabs = this.fileTabs();
    if (!tabs.some((t) => normalizePathSlashes(t.relativePath) === norm)) {
      this.fileTabs.update((ts) => [...ts, { relativePath: norm }]);
    }
    this.activeMainTabId.set(id);
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
  }

  protected async closeMainFileTab(event: MouseEvent, tabId: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (tabId === 'conversation' || !tabId.startsWith('file:')) {
      return;
    }
    const norm = normalizePathSlashes(tabId.slice(5));
    if (this.fileTabIsUnsaved(norm)) {
      const discard = await this.themedConfirm.open(unsavedCloseFileTabPrompt(norm));
      if (!discard) {
        return;
      }
    }
    if (this.activeMainTabId() === tabId) {
      this.activeMainTabId.set('conversation');
    }
    this.fileTabs.update((ts) => ts.filter((t) => normalizePathSlashes(t.relativePath) !== norm));
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

  protected fileTabIdForPath(relativePath: string): string {
    return chatFileTabId(relativePath);
  }

  protected fileTabBasenameForPath(relativePath: string): string {
    return chatFileTabBasename(relativePath);
  }

  protected onMonacoUnsavedPathsChange(paths: readonly string[]): void {
    const next = new Set(paths.map((p) => normalizePathSlashes(p)));
    this.monacoUnsavedPaths.set(next);
    this.electron.reportWorkspaceMonacoUnsavedPaths([...next]);
  }

  protected fileTabIsUnsaved(relativePath: string): boolean {
    return this.monacoUnsavedPaths().has(normalizePathSlashes(relativePath));
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
    moeStreams?: StreamPart[],
    auxiliaryStreamTimeline?: StreamPart[],
  ): void {
    console.log('[App] pushMessage:', role, 'text length:', text.length);
    let nextMessage: ChatMessage;
    if (role === 'user') {
      nextMessage = { role, text };
    } else {
      const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text };
      if (toolStreams?.length) assistant.toolStreams = toolStreams;
      if (moeStreams?.length) assistant.moeStreams = moeStreams;
      if (auxiliaryStreamTimeline?.length) assistant.auxiliaryStreamTimeline = auxiliaryStreamTimeline;
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
    const config = await this.electron.loadConfig();
    if (config.lastActiveConversationByWorkspaceId?.[key] === conv.id) {
      return;
    }
    const next: AppConfig = {
      ...config,
      lastActiveConversationByWorkspaceId: {
        ...(config.lastActiveConversationByWorkspaceId ?? {}),
        [key]: conv.id,
      },
    };
    await this.electron.saveConfig(next);
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
    } else {
      this.streamingParts.set([]);
      this.backgroundStreamParts.delete(conv.id);
    }

    // Resolve theme: workspace theme > noWorkspaceThemeId > dark
    const config = await this.electron.loadConfig();
    applyAppTheme(resolveAppThemeId(config, workspaceId));
    void this.rememberLastActiveForWorkspace(conv);
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
    moeStreams?: StreamPart[],
    auxiliaryStreamTimeline?: StreamPart[],
  ): Promise<void> {
    const prev = this.backgroundConversationSaveChains.get(conversationId) ?? Promise.resolve();
    const mine = prev.then(async () => {
      try {
        const convMeta = this.conversations().find(c => c.id === conversationId);
        const workspaceId = convMeta?.workspaceId ?? this.currentWorkspaceId();
        const conv = await this.electron.readConversationFromDisk(conversationId, workspaceId);
        const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text };
        if (toolStreams?.length) assistant.toolStreams = toolStreams;
        if (moeStreams?.length) assistant.moeStreams = moeStreams;
        if (auxiliaryStreamTimeline?.length) assistant.auxiliaryStreamTimeline = auxiliaryStreamTimeline;
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

  /** Merge status updates by backend `id` so a later `complete`/`error` row replaces the running row instead of leaving it spinning. */
  private upsertChainMessage(status: LlmStatus): void {
    this.messages.update((prev) => {
      const nextRow: ChatMessage = {
        role: 'chain',
        label: status.label,
        text: status.detail,
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
      const proceed = await this.themedConfirm.open(unsavedWorkspaceSwitchPrompt(unsaved));
      if (!proceed) {
        return false;
      }
    }

    const pending = this.getPendingStreamIdsForWorkspace(fromWorkspaceId);
    if (pending.length > 0) {
      const proceed = await this.themedConfirm.open(activeStreamWorkspaceSwitchPrompt(pending.length));
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

  protected onTalkCaptureFinished(event: { hadSpeech: boolean }): void {
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
}
