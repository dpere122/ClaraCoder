/**
 * Main chat shell: conversations, workspace chrome, IPC-driven streaming, and layout resize handles.
 * TTS playback lives in {@link TtsPlaybackService}; this component wires signals and `ElectronService` streams.
 */
import { Component, computed, effect, model, NgZone, OnDestroy, OnInit, signal } from '@angular/core';
import type { Conversation, ConversationMeta, LlmAgentRole, LlmStatus, StreamPart, Workspace } from '@shared/index';
import {
  primaryAssistantTextFromParts,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
} from '@shared/index';
import { ChatBox, ChatMessage } from '../chat/chat-box/chat-box';
import { MessageBox } from '../chat/message-box/message-box';
import { ConversationManager } from '../chat/conversation-manager/conversation-manager';
import { ToolsBar } from '../layout/tools-bar/tools-bar';
import { WorkspaceComponent } from '../workspace/workspace/workspace';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { THEMES } from '../layout/theme-selector/theme-selector';

function labelForStreamTag(tag: string): string {
  if (tag === 'mgr') return 'Manager';
  if (tag === 'worker') return 'Workspace worker';
  if (tag === 'agent') return 'Reply';
  if (tag === 'planning') return 'Planning';
  if (tag.startsWith('spec-')) {
    const kind = tag.slice('spec-'.length).split('-')[0] ?? '';
    const names: Record<string, string> = {
      read: 'Read',
      create: 'Create',
      update: 'Update',
      delete: 'Delete',
    };
    return `${names[kind] ?? 'Specialist'} specialist`;
  }
  return 'Reply';
}

function appendStreamPart(parts: StreamPart[], streamTag: string | undefined, delta: string): StreamPart[] {
  const t = streamTag?.trim() ? streamTag.trim() : 'agent';
  const label = labelForStreamTag(t);
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.streamTag === t) {
    next[next.length - 1] = { ...last, text: last.text + delta };
    return next;
  }
  next.push({ streamTag: t, label, text: delta });
  return next;
}

@Component({
  selector: 'app-root',
  imports: [ChatBox, MessageBox, ConversationManager, ToolsBar, WorkspaceComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly pinned = signal(false);
  protected readonly pendingIds = signal<Set<string>>(new Set());
  protected readonly loading = computed(() => {
    const id = this.activeConversationId();
    return id != null && this.pendingIds().has(id);
  });
  protected readonly conversations = signal<ConversationMeta[]>([]);
  protected readonly activeConversationId = signal<string | null>(null);
  protected readonly fontSize = signal(0.9);
  protected readonly speechEnabled = signal(false);
  protected readonly selectedVoice = signal('en-US-AriaNeural');
  protected readonly talkStatus = signal('');
  protected readonly talkEnabled = signal(false);
  /**
   * Editor mode: when true, the backend binds edit/write tools (`apply_mode`). When false, read/search only.
   * Auto apply is only available in the toolbar when this is on.
   */
  protected readonly editorMode = model(true);
  /** When true, backend applies proposed edits immediately without diff review pause (`auto_apply_mode`). */
  protected readonly autoApplyMode = model(false);
  /** In-flight model tokens grouped by backend ``stream_tag`` (manager vs nested specialists, etc.). */
  protected readonly streamingParts = signal<StreamPart[]>([]);
  /** Read-tool payloads streamed for the live bubble only (not saved with the assistant message). */
  protected readonly toolReadStreamText = signal('');
  protected readonly settingsWindowOpen = signal(false);
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
  /** Short hint while a workspace tool runs (tool name / path from backend status). */
  protected readonly processingToolHint = signal('');
  /** While the model step runs (no tool yet), show Manager vs Worker in the processing row. */
  protected readonly processingAgentRole = signal<LlmAgentRole | null>(null);

  // Workspace management
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly currentWorkspaceId = signal<string | null>(null);
  protected readonly currentWorkspace = computed(() => {
    const id = this.currentWorkspaceId();
    return this.workspaces().find(w => w.id === id) ?? null;
  });

  // Layout
  protected readonly workspaceWidth = signal(220);
  protected readonly sidebarWidth = signal(220);

  private static readonly MIN_WORKSPACE = 140;
  private static readonly MAX_WORKSPACE = 500;
  private static readonly MIN_SIDEBAR = 140;
  private static readonly MAX_SIDEBAR = 500;

  private activeConversation: Conversation | null = null;
  private backgroundStreamParts = new Map<string, StreamPart[]>();
  private backgroundToolReadChunks = new Map<string, string>();
  private resizing: 'workspace' | 'sidebar' | null = null;
  private boundOnResizeMove = this.onResizeMove.bind(this);
  private boundOnResizeEnd = this.onResizeEnd.bind(this);
  private pendingSave = false;
  private workspaceSyncToken = 0;

  constructor(
    private electron: ElectronService,
    private zone: NgZone,
    protected readonly tts: TtsPlaybackService,
  ) {
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
      }
    });

    this.electron.config$.subscribe((config) => {
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

    this.electron.toolReadChunk$.subscribe(({ conversationId, delta }) => {
      if (conversationId === this.activeConversationId()) {
        this.toolReadStreamText.update((prev) => prev + delta);
      } else {
        const prev = this.backgroundToolReadChunks.get(conversationId) ?? '';
        this.backgroundToolReadChunks.set(conversationId, prev + delta);
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

    this.electron.deleteConfirm$.subscribe(({ conversationId, payload }) => {
      if (conversationId !== this.activeConversationId()) return;
      if (payload.version !== 1 || !payload.requestId || !payload.relativePath) return;
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
        const d = status.detail?.trim();
        this.processingToolHint.set(d ? `${status.label}: ${d}` : status.label);
        this.upsertChainMessage(status);
        return;
      }
      if (src === 'tool' && (status.state === 'complete' || status.state === 'error')) {
        this.toolRunIds.update((s) => {
          const next = new Set(s);
          next.delete(status.id);
          if (next.size === 0) {
            this.processingToolHint.set('');
          }
          return next;
        });
      }
      if (src === 'agent' && status.state === 'running' && status.agentRole) {
        this.processingAgentRole.set(status.agentRole);
      }
      // Persist chain rows until the reply finishes (`done$`).
      this.upsertChainMessage(status);
    });

    this.electron.done$.subscribe(({ conversationId }) => {
      this.removePending(conversationId);
      if (conversationId === this.activeConversationId()) {
        const roleForSavedReply = this.processingAgentRole();
        const parts = this.streamingParts();
        this.toolRunIds.set(new Set());
        this.toolPhaseEngaged.set(false);
        this.processingToolHint.set('');
        this.processingAgentRole.set(null);
        this.streamingParts.set([]);
        this.toolReadStreamText.set('');
        const text = primaryAssistantTextFromParts(parts, roleForSavedReply);
        if (text) {
          this.pushMessage('assistant', text);
          if (this.speechEnabled()) void this.tts.speakText(text, this.selectedVoice());
          this.autoSave();
        }
      } else {
        const parts = this.backgroundStreamParts.get(conversationId) ?? [];
        this.backgroundStreamParts.delete(conversationId);
        this.backgroundToolReadChunks.delete(conversationId);
        const text = primaryAssistantTextFromParts(parts);
        if (text) {
          this.saveMessageToConversation(conversationId, text);
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
    this.processingAgentRole.set(null);
    this.streamingParts.set([]);
    this.toolReadStreamText.set('');
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
    this.processingToolHint.set('');
    this.processingAgentRole.set(null);
    this.streamingParts.set([]);
    this.toolReadStreamText.set('');
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
      await this.electron.setWorkspaceContext(convId, workspacePath, tree);
    } catch (err) {
      console.error('[App] Failed to sync workspace context:', err);
    }
  }

  private pushMessage(role: 'user' | 'assistant', text: string): void {
    console.log('[App] pushMessage:', role, 'text length:', text.length);
    this.messages.update((prev) => [...prev, { role, text }]);
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
    this.processingToolHint.set('');
    this.processingAgentRole.set(null);
    const stillStreaming = this.pendingIds().has(conv.id);
    if (stillStreaming) {
      const bgParts = this.backgroundStreamParts.get(conv.id) ?? [];
      this.streamingParts.set(bgParts.length ? [...bgParts] : []);
      this.backgroundStreamParts.delete(conv.id);
      const tr = this.backgroundToolReadChunks.get(conv.id) ?? '';
      this.toolReadStreamText.set(tr);
      this.backgroundToolReadChunks.delete(conv.id);
    } else {
      this.streamingParts.set([]);
      this.toolReadStreamText.set('');
      this.backgroundStreamParts.delete(conv.id);
      this.backgroundToolReadChunks.delete(conv.id);
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

  private async saveMessageToConversation(conversationId: string, text: string): Promise<void> {
    try {
      // Find the conversation's workspaceId from the list
      const convMeta = this.conversations().find(c => c.id === conversationId);
      const workspaceId = convMeta?.workspaceId ?? this.currentWorkspaceId();
      const conv = await this.electron.loadConversation(conversationId, workspaceId);
      conv.messages.push({ role: 'assistant', text });
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

  private applyTheme(themeId: string): void {
    const theme = THEMES.find((t) => t.id === themeId);
    document.documentElement.className = theme?.cssClass ?? '';
    document.documentElement.setAttribute('data-bs-theme', theme?.bsTheme ?? 'dark');
  }
}
