/**
 * Main chat shell: conversations, workspace chrome, IPC-driven streaming, and layout resize handles.
 * TTS playback lives in {@link TtsPlaybackService}; this component wires signals and `ElectronService` streams.
 */
import { Component, computed, effect, model, NgZone, OnDestroy, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  Conversation,
  ConversationMeta,
  LlmStatus,
  PlannerProgress,
  StreamPart,
  Workspace,
} from '@shared/index';
import {
  collapseExcessiveAssistantBlankLines,
  delegatedStreamPartsForDisplay,
  emptyPrimaryAssistantFallbackMessage,
  findLlmModelLocation,
  gemmaTemplateSanitizeActive,
  isMoeAuxiliaryStreamTag,
  isShellStyleToolStreamTag,
  multiplexAuxiliaryStreamTimeline,
  primaryAssistantTextFromParts,
  resolveActiveLlmConnection,
  stripAssistantChannelNoise,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  toolTrailStatusStreamTag,
} from '@shared/index';
import { ChatBox, ChatMessage } from '../chat/chat-box/chat-box';
import { MessageBox } from '../chat/message-box/message-box';
import { ConversationManager } from '../chat/conversation-manager/conversation-manager';
import { LlamaServerTile } from '../chat/llama-server-tile/llama-server-tile';
import { ToolsBar } from '../layout/tools-bar/tools-bar';
import { buildContextCapacitySnapshot } from '../status/context-capacity/context-capacity.utils';
import { StatusBarComponent } from '../status/status-bar/status-bar';
import { WorkspaceComponent } from '../workspace/workspace/workspace';
import { WorkspaceTerminalDockComponent } from '../workspace-terminal/workspace-terminal-dock';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { THEMES } from '../layout/theme-selector/theme-selector';

const DEFAULT_REASONING_STREAM_LABEL = 'Model reasoning';

const LLAMA_SERVER_DOCK_STORAGE_KEY = 'nemo.llamaServerDock';

type LlamaServerDockSide = 'conversations' | 'workspace';

function readLlamaServerDockFromStorage(): LlamaServerDockSide {
  try {
    if (typeof localStorage === 'undefined') {
      return 'conversations';
    }
    const v = localStorage.getItem(LLAMA_SERVER_DOCK_STORAGE_KEY)?.trim();
    if (v === 'workspace') {
      return 'workspace';
    }
  } catch {
    /* ignore */
  }
  return 'conversations';
}

function appendStreamPart(
  parts: StreamPart[],
  streamTag: string | undefined,
  delta: string,
  label = '',
): StreamPart[] {
  const t = streamTag?.trim() ? streamTag.trim() : 'agent';
  const resolvedLabel = label || (isMoeAuxiliaryStreamTag(t) ? DEFAULT_REASONING_STREAM_LABEL : '');
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.streamTag === t) {
    next[next.length - 1] = { ...last, label: last.label || resolvedLabel, text: last.text + delta };
    return next;
  }
  next.push({ streamTag: t, label: resolvedLabel, text: delta });
  return next;
}

/** Insert or update a tool-status row in the multiplex timeline (wall-clock order vs. `moe` chunks). */
function upsertToolTrailStatusStreamPart(parts: StreamPart[], status: LlmStatus): StreamPart[] {
  const src = (status.source ?? 'agent').toLowerCase();
  if (src !== 'tool') {
    return parts;
  }
  const streamTag = toolTrailStatusStreamTag(status.id);
  const next = [...parts];
  const idx = next.findIndex((p) => p.streamTag === streamTag);
  const row: StreamPart = {
    streamTag,
    label: status.label,
    text: status.detail ?? '',
    toolChainState: status.state,
  };
  if (idx >= 0) {
    next[idx] = { ...next[idx], ...row };
    return next;
  }
  return [...next, row];
}

function markToolExecStreamComplete(
  parts: StreamPart[],
  streamTag: string | undefined,
  exitCode: number | null | undefined,
  outputExcerpt?: string,
): StreamPart[] {
  const t = streamTag?.trim();
  if (!t) {
    return parts;
  }
  const next = parts.map((p) => ({ ...p }));
  const ex = outputExcerpt?.trim();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].streamTag.trim() === t) {
      let text = next[i].text;
      if (ex) {
        const head = ex.slice(0, Math.min(160, ex.length));
        if (!text.trim()) {
          text = ex;
        } else if (!text.includes(head)) {
          text = `${text.endsWith('\n') ? text : `${text}\n`}\n${ex}`;
        }
      }
      next[i] = {
        ...next[i],
        text,
        runComplete: true,
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
      break;
    }
  }
  return next;
}

@Component({
  selector: 'app-root',
  imports: [
    ChatBox,
    MessageBox,
    ConversationManager,
    LlamaServerTile,
    ToolsBar,
    WorkspaceComponent,
    WorkspaceTerminalDockComponent,
    StatusBarComponent,
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
  protected readonly selectedVoice = model('en-US-AriaNeural');
  protected readonly talkStatus = model('');
  protected readonly talkEnabled = model(false);
  /**
   * Editor mode: when true, the backend binds edit/write tools (`apply_mode`). When false, read/search only.
   * Auto apply is only available in the toolbar when this is on.
   */
  protected readonly editorMode = model(true);
  /** When true, backend applies proposed edits immediately without diff review pause (`auto_apply_mode`). */
  protected readonly autoApplyMode = model(false);
  protected readonly streamingParts = signal<StreamPart[]>([]);
  protected readonly livePlannerProgress = signal<PlannerProgress | null>(null);
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
        opts.push({ id: m.id, label: `${m.name} · ${m.model}` });
      }
    }
    return opts;
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
  private backgroundPlannerProgress = new Map<string, PlannerProgress>();
  private resizing: 'workspace' | 'sidebar' | null = null;
  private boundOnResizeMove = this.onResizeMove.bind(this);
  private boundOnResizeEnd = this.onResizeEnd.bind(this);
  private pendingSave = false;
  private workspaceSyncToken = 0;

  constructor(
    protected readonly electron: ElectronService,
    private zone: NgZone,
    protected readonly tts: TtsPlaybackService,
  ) {
    this.electron.windowMaximized$
      .pipe(takeUntilDestroyed())
      .subscribe((maximized) => this.windowMaximized.set(maximized));

    effect(() => {
      if (!this.speechEnabled()) this.tts.invalidateSpeechPipeline();
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

    this.electron.config$.subscribe((config) => {
      this.appConfig.set(config);
      // Resolve theme: workspace theme > noWorkspaceThemeId > dark
      let themeToApply = config.noWorkspaceThemeId || 'dark';
      if (config.currentWorkspaceId) {
        const workspace = config.workspaces.find(w => w.id === config.currentWorkspaceId);
        if (workspace?.themeId) {
          themeToApply = workspace.themeId;
        }
      }
      this.applyTheme(themeToApply);
      this.workspaces.set(config.workspaces);
      this.currentWorkspaceId.set(config.currentWorkspaceId);
    });

    this.electron.settingsWindowVisibility$.subscribe((isOpen) => {
      this.settingsWindowOpen.set(isOpen);
    });

    this.electron.chunk$.subscribe(({ conversationId, delta, streamTag }) => {
      const toolRunInProgress = this.toolRunIds().size > 0;
      if (shouldIgnoreWhitespaceOnlyModelChunkDuringTool(delta, toolRunInProgress)) {
        return;
      }
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => appendStreamPart(prev, streamTag, delta));
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(conversationId, appendStreamPart(prev, streamTag, delta));
      }
    });

    this.electron.toolExecChunk$.subscribe(({ conversationId, delta, streamTag, label }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => appendStreamPart(prev, streamTag, delta, label ?? ''));
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(conversationId, appendStreamPart(prev, streamTag, delta, label ?? ''));
      }
    });

    this.electron.toolExecComplete$.subscribe(({ conversationId, streamTag, exitCode, outputExcerpt }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) =>
          markToolExecStreamComplete(prev, streamTag, exitCode, outputExcerpt),
        );
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.set(
          conversationId,
          markToolExecStreamComplete(prev, streamTag, exitCode, outputExcerpt),
        );
      }
    });

    this.electron.planner$.subscribe(({ conversationId, planner }) => {
      if (conversationId === this.activeConversationId()) {
        this.livePlannerProgress.set(planner);
      } else {
        this.backgroundPlannerProgress.set(conversationId, planner);
      }
    });

    this.electron.diff$.subscribe(({ conversationId, diff }) => {
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

    this.electron.acceptCommand$.subscribe(({ conversationId, payload }) => {
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

    this.electron.copyConfirm$.subscribe(({ conversationId, payload }) => {
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

    this.electron.deleteConfirm$.subscribe(({ conversationId, payload }) => {
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

    this.electron.llmStatus$.subscribe(({ conversationId, status }) => {
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

    this.electron.done$.subscribe(({ conversationId }) => {
      this.removePending(conversationId);
      if (conversationId === this.activeConversationId()) {
        const parts = this.streamingParts();
        const planner = this.livePlannerProgress();
        const toolStreamCandidates = delegatedStreamPartsForDisplay(parts, null).filter(
          (p) => isShellStyleToolStreamTag(p.streamTag) && p.text.trim(),
        );
        const toolStreams = toolStreamCandidates.length > 0 ? toolStreamCandidates : undefined;
        const moeCandidates = parts.filter((p) => isMoeAuxiliaryStreamTag(p.streamTag) && p.text.trim());
        const moeStreams = moeCandidates.length > 0 ? moeCandidates : undefined;
        const timelineParts = multiplexAuxiliaryStreamTimeline(parts);
        const auxiliaryStreamTimeline = timelineParts.length > 0 ? timelineParts : undefined;
        const hasReasoningStreamText = moeCandidates.length > 0;
        this.toolRunIds.set(new Set());
        this.toolPhaseEngaged.set(false);
        this.streamingParts.set([]);
        this.livePlannerProgress.set(null);
        this.backgroundPlannerProgress.delete(conversationId);
        let text = primaryAssistantTextFromParts(parts);
        if (
          !text.trim() &&
          (parts.length > 0 ||
            planner != null ||
            (toolStreams?.length ?? 0) > 0 ||
            (moeStreams?.length ?? 0) > 0 ||
            (auxiliaryStreamTimeline?.length ?? 0) > 0)
        ) {
          text = emptyPrimaryAssistantFallbackMessage(hasReasoningStreamText);
        }
        text = this.sanitizeAssistantTextForActiveModel(text);
        if (
          text.trim() ||
          (toolStreams?.length ?? 0) > 0 ||
          (moeStreams?.length ?? 0) > 0 ||
          (auxiliaryStreamTimeline?.length ?? 0) > 0
        ) {
          this.pushMessage('assistant', text, planner, toolStreams, moeStreams, auxiliaryStreamTimeline);
          if (this.speechEnabled() && text.trim()) void this.tts.speakText(text, this.selectedVoice());
          this.autoSave();
        }
      } else {
        const parts = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.delete(conversationId);
        const planner = this.backgroundPlannerProgress.get(conversationId) ?? null;
        this.backgroundPlannerProgress.delete(conversationId);
        const toolStreamCandidates = delegatedStreamPartsForDisplay(parts, null).filter(
          (p) => isShellStyleToolStreamTag(p.streamTag) && p.text.trim(),
        );
        const toolStreams = toolStreamCandidates.length > 0 ? toolStreamCandidates : undefined;
        const moeCandidates = parts.filter((p) => isMoeAuxiliaryStreamTag(p.streamTag) && p.text.trim());
        const moeStreams = moeCandidates.length > 0 ? moeCandidates : undefined;
        const timelinePartsBg = multiplexAuxiliaryStreamTimeline(parts);
        const auxiliaryStreamTimeline = timelinePartsBg.length > 0 ? timelinePartsBg : undefined;
        const hasReasoningStreamText = moeCandidates.length > 0;
        let text = primaryAssistantTextFromParts(parts);
        if (
          !text.trim() &&
          (parts.length > 0 ||
            planner != null ||
            (toolStreams?.length ?? 0) > 0 ||
            (moeStreams?.length ?? 0) > 0 ||
            (auxiliaryStreamTimeline?.length ?? 0) > 0)
        ) {
          text = emptyPrimaryAssistantFallbackMessage(hasReasoningStreamText);
        }
        text = this.sanitizeAssistantTextForActiveModel(text);
        if (
          text.trim() ||
          (toolStreams?.length ?? 0) > 0 ||
          (moeStreams?.length ?? 0) > 0 ||
          (auxiliaryStreamTimeline?.length ?? 0) > 0
        ) {
          void this.saveMessageToConversation(
            conversationId,
            text,
            planner,
            toolStreams,
            moeStreams,
            auxiliaryStreamTimeline,
          );
        }
      }
    });

    this.electron.openWorkspace$.subscribe((workspacePath) => {
      void this.handleOpenWorkspace(workspacePath);
    });

    this.electron.openConversation$.subscribe((conversationId) => {
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
    let themeToApply = config.noWorkspaceThemeId || 'dark';
    if (config.currentWorkspaceId) {
      const workspace = config.workspaces.find(w => w.id === config.currentWorkspaceId);
      if (workspace?.themeId) {
        themeToApply = workspace.themeId;
      }
    }
    this.applyTheme(themeToApply);

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
    const list = await this.electron.getConversations(wsId);
    console.log('[App] loadConversationsForWorkspace: got', list.length, 'conversations');
    this.conversations.set(list);

    if (list.length === 0) {
      // No conversations in this workspace, create one
      console.log('[App] loadConversationsForWorkspace: no conversations, creating new');
      await this.onNewConversation();
    } else {
      // Load the most recent conversation - use its stored workspaceId
      const conv = list[0];
      console.log('[App] loadConversationsForWorkspace: loading conv:', conv.id, 'workspaceId:', conv.workspaceId);
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
    this.streamingParts.set([]);
    this.livePlannerProgress.set(null);
    this.backgroundPlannerProgress.delete(convId);
    this.electron.sendMessage(
      convId,
      normalized,
      this.editorMode(),
      this.editorMode() && this.autoApplyMode(),
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
    this.livePlannerProgress.set(null);
    // Resolve theme: workspace theme > noWorkspaceThemeId > dark
    const config = await this.electron.loadConfig();
    let themeToApply = config.noWorkspaceThemeId || 'dark';
    if (workspaceId) {
      const workspace = config.workspaces.find(w => w.id === workspaceId);
      if (workspace?.themeId) {
        themeToApply = workspace.themeId;
      }
    }
    this.applyTheme(themeToApply);
    await this.refreshConversationList();
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
      console.log('[App] Updated activeConversation.title to:', event.title);
    }
    // Update the list in place so the sidebar title changes immediately.
    this.updateConversationMeta(event.id, { title: event.title, updatedAt: new Date().toISOString() });
  }

  onLlamaServerDockChange(target: LlamaServerDockSide): void {
    if (target !== 'conversations' && target !== 'workspace') {
      return;
    }
    this.llamaServerDock.set(target);
    try {
      localStorage.setItem(LLAMA_SERVER_DOCK_STORAGE_KEY, target);
    } catch {
      /* ignore */
    }
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
      await this.electron.setWorkspaceContext(convId, workspacePath, tree, {
        workspaceId: this.currentWorkspaceId() ?? '',
      });
    } catch (err) {
      console.error('[App] Failed to sync workspace context:', err);
    }
  }

  /** Strip channel noise (all models); extra blank-line collapse for Gemma-oriented connections. */
  private sanitizeAssistantTextForActiveModel(text: string): string {
    let t = stripAssistantChannelNoise(text);
    const conn = this.activeLlmConnection();
    if (
      conn &&
      gemmaTemplateSanitizeActive({ optimizationPreset: conn.optimizationPreset, model: conn.model })
    ) {
      t = collapseExcessiveAssistantBlankLines(t);
    }
    return t;
  }

  private pushMessage(
    role: 'user' | 'assistant',
    text: string,
    planner: PlannerProgress | null = null,
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
      if (planner) assistant.planner = planner;
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

  private async loadConversation(id: string, workspaceId?: string | null): Promise<void> {
    const conv = await this.electron.loadConversation(id, workspaceId);
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
      this.livePlannerProgress.set(this.backgroundPlannerProgress.get(conv.id) ?? null);
    } else {
      this.streamingParts.set([]);
      this.backgroundStreamParts.delete(conv.id);
      this.livePlannerProgress.set(null);
    }

    // Resolve theme: workspace theme > noWorkspaceThemeId > dark
    const config = await this.electron.loadConfig();
    let themeToApply = config.noWorkspaceThemeId || 'dark';
    if (workspaceId) {
      const workspace = config.workspaces.find(w => w.id === workspaceId);
      if (workspace?.themeId) {
        themeToApply = workspace.themeId;
      }
    }
    this.applyTheme(themeToApply);
  }

  private async saveCurrentConversation(): Promise<void> {
    if (!this.activeConversation) {
      console.log('[App] saveCurrentConversation: no active conversation');
      return;
    }

    if (this.pendingSave) {
      console.log('[App] saveCurrentConversation: saving, pendingSave was true');
      this.pendingSave = false;
      this.activeConversation.messages = [...this.messages()];
      this.activeConversation.updatedAt = new Date().toISOString();
      console.log('[App] Saving conversation with', this.activeConversation.messages.length, 'messages');
      await this.electron.saveConversation(this.activeConversation);
      console.log('[App] Conversation saved successfully');
    } else {
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

  private async saveMessageToConversation(
    conversationId: string,
    text: string,
    planner: PlannerProgress | null = null,
    toolStreams?: StreamPart[],
    moeStreams?: StreamPart[],
    auxiliaryStreamTimeline?: StreamPart[],
  ): Promise<void> {
    try {
      // Find the conversation's workspaceId from the list
      const convMeta = this.conversations().find(c => c.id === conversationId);
      const workspaceId = convMeta?.workspaceId ?? this.currentWorkspaceId();
      const conv = await this.electron.loadConversation(conversationId, workspaceId);
      const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text };
      if (planner) assistant.planner = planner;
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

  private async refreshConversationList(): Promise<void> {
    const wsId = this.currentWorkspaceId();
    const list = await this.electron.getConversations(wsId);
    this.conversations.set(list);
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
    const conv = await this.electron.loadConversation(targetId);

    if (conv.workspaceId !== this.currentWorkspaceId()) {
      await this.electron.setCurrentWorkspace(conv.workspaceId);
      const config = await this.electron.loadConfig();
      this.workspaces.set(config.workspaces);
      this.currentWorkspaceId.set(config.currentWorkspaceId);
      const list = await this.electron.getConversations(conv.workspaceId);
      this.conversations.set(list);
    }

    await this.loadConversation(conv.id, conv.workspaceId);
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

  protected onWindowToggleMaximize(): void {
    this.electron.windowToggleMaximize();
  }

  protected onWindowClose(): void {
    this.electron.windowClose();
  }

  private applyTheme(themeId: string): void {
    const theme = THEMES.find((t) => t.id === themeId);
    document.documentElement.className = theme?.cssClass ?? '';
    document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
  }
}
