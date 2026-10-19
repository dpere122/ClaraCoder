/**
 * Conversation lifecycle: load/save, streaming IPC, HITL artifacts, and pending-stream state.
 * Workspace chrome and Monaco tabs remain in {@link App}.
 */
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AppConfig,
  ChatStructuredContentPart,
  Conversation,
  ConversationMeta,
  HitlTrailArtifact,
  LlamaServerLifecycleEvent,
  LlamaServerProcessExitEvent,
  LlmStatus,
  PlannerProgress,
  StreamPart,
  TurnEditedFile,
} from '@shared/index';
import {
  buildTurnFeed,
  clearPrimaryStreamParts,
  promotePrimaryToNudgeParts,
  findManagedLocalLlamaLocation,
  isClaraOuterBriefStreamTag,
  isInFlightToolPart,
  mergeHitlTrailIntoAuxiliaryTimeline,
  primaryAssistantTextFromParts,
  isWorkspaceReadToolLabel,
  shouldIgnoreWhitespaceOnlyModelChunkDuringTool,
  appendAndMergeReadToolPreviewChunk,
  findReadToolTrailTargetIndex,
  toolTrailStatusIdFromStreamTag,
  toolTrailStatusStreamTag,
} from '@shared/index';
import type { ChatHubView } from '../chat/chat-conversation-hub/chat-conversation-hub';
import {
  buildChatDisplayRows,
  hitlArtifactsExcludingPlanConfirm,
  isReadToolInFlight,
  resolveLiveAssistantTurn,
  resolvePrimaryStreamLiveText,
  resolveTurnActivity,
  turnHasPendingHitlArtifacts,
  type ChatMessage,
  type TurnActivity,
} from '../chat/chat-box/chat-box';
import { LiveTurnActivityService } from '../chat/chat-box/live-turn-activity';
import { ElectronService } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { buildAssistantTurnFromStreamParts } from './app-assistant-turn';
import {
  appendStreamPart,
  markToolExecStreamComplete,
  upsertClaraOuterBriefStreamPart,
  upsertToolTrailStatusStreamPart,
} from './app-stream-parts';
import { abandonStaleHitlMessages } from './abandon-stale-hitl';
import { filter, merge } from 'rxjs';
/** Choose text for end-of-turn TTS flush (see App for rationale). */
export function pickTtsFlushText(streamedPrimary: string, finalText: string): string {
  const a = streamedPrimary.trim();
  const b = finalText.trim();
  if (!b) return streamedPrimary;
  if (!a) return finalText;
  if (b.startsWith(a) || a.startsWith(b)) {
    return b.length >= a.length ? finalText : streamedPrimary;
  }
  let lcp = 0;
  const limit = Math.min(a.length, b.length);
  while (lcp < limit && a[lcp] === b[lcp]) {
    lcp++;
  }
  if (lcp < a.length * 0.5) {
    return streamedPrimary;
  }
  return b.length >= a.length ? finalText : streamedPrimary;
}

export interface ConversationSessionHooks {
  getCurrentWorkspaceId: () => string | null;
  getSpeechSettings: () => { enabled: boolean; voice: string; speed: number };
  onPlannerComplete?: (conversationId: string) => void;
  onConversationLoaded?: (conversationId: string) => void;
}

@Injectable({ providedIn: 'root' })
export class ConversationSessionService {
  private readonly electron = inject(ElectronService);
  private readonly tts = inject(TtsPlaybackService);
  private readonly liveTurnActivity = inject(LiveTurnActivityService);
  private readonly destroyRef = inject(DestroyRef);

  readonly messages = signal<ChatMessage[]>([]);
  readonly pendingIds = signal<Set<string>>(new Set());
  readonly loading = computed(() => {
    const id = this.activeConversationId();
    return id != null && this.pendingIds().has(id);
  });
  readonly conversations = signal<ConversationMeta[]>([]);
  readonly activeConversationId = signal<string | null>(null);
  readonly streamingParts = signal<StreamPart[]>([]);
  readonly streamingPlanner = signal<PlannerProgress | null>(null);
  readonly streamingFinalText = signal<string | undefined>(undefined);
  readonly chatHubView = signal<ChatHubView>('activeChat');
  /** True while save + `new-conversation` IPC is in flight (drives the chat-panel overlay). */
  readonly creatingConversation = signal(false);

  private readonly toolRunIds = signal<Set<string>>(new Set());
  /** True while a tool status is running or a shell/overlay stream has not completed. */
  readonly processingToolsActive = computed(
    () => this.toolRunIds().size > 0 || this.streamingParts().some(isInFlightToolPart),
  );

  /** True while the active conversation's live turn is blocked on a HITL card. */
  private readonly activeAwaitingReview = computed(() => {
    const id = this.activeConversationId();
    if (!id || !this.pendingIds().has(id)) {
      return false;
    }
    const live = resolveLiveAssistantTurn(buildChatDisplayRows([...this.messages()]));
    return live != null && turnHasPendingHitlArtifacts(live.artifacts);
  });

  /**
   * What each streaming conversation is doing right now (same resolver as the live processing
   * row), so the conversation list can show the matching spinner on every pending row. For the
   * active conversation, the spinner the mounted chat box is showing wins when there is one.
   */
  readonly conversationActivity = computed<ReadonlyMap<string, TurnActivity>>(() => {
    this.backgroundStreamVersion();
    const activeId = this.activeConversationId();
    const out = new Map<string, TurnActivity>();
    for (const id of this.pendingIds()) {
      if (id === activeId) {
        const shown = this.liveTurnActivity.shown();
        if (shown?.conversationId === id) {
          out.set(id, shown.activity);
          continue;
        }
        const parts = this.streamingParts();
        const toolsActive = this.processingToolsActive();
        const finalText = this.streamingFinalText();
        out.set(
          id,
          resolveTurnActivity({
            feed: buildTurnFeed(parts, finalText),
            primaryLiveText: resolvePrimaryStreamLiveText(finalText, parts, toolsActive),
            toolsActive,
            readToolActive: isReadToolInFlight(parts, toolsActive),
            awaitingReview: this.activeAwaitingReview(),
          }),
        );
        continue;
      }
      const parts = this.backgroundStreamParts.get(id) ?? [];
      const runLabels = [...(this.backgroundToolRuns.get(id)?.values() ?? [])];
      const toolsActive = runLabels.length > 0 || parts.some(isInFlightToolPart);
      const finalText = this.pendingFinalText.get(id);
      const latestRunLabel = runLabels[runLabels.length - 1];
      out.set(
        id,
        resolveTurnActivity({
          feed: buildTurnFeed(parts, finalText),
          primaryLiveText: resolvePrimaryStreamLiveText(finalText, parts, toolsActive),
          toolsActive,
          readToolActive:
            isReadToolInFlight(parts, toolsActive) ||
            (latestRunLabel != null && isWorkspaceReadToolLabel(latestRunLabel)),
          awaitingReview: this.backgroundAwaitingReview.has(id),
        }),
      );
    }
    return out;
  });

  private activeConversation: Conversation | null = null;
  private readonly backgroundStreamParts = new Map<string, StreamPart[]>();
  /** Running tool statuses (id -> label) for streaming conversations that are not active. */
  private readonly backgroundToolRuns = new Map<string, Map<string, string>>();
  /** Background conversations whose live turn is blocked on a HITL card. */
  private readonly backgroundAwaitingReview = new Set<string>();
  /** Bumped whenever the background maps change so {@link conversationActivity} recomputes. */
  private readonly backgroundStreamVersion = signal(0);
  private readonly backgroundStreamPlanner = new Map<string, PlannerProgress>();
  private readonly pendingFinalText = new Map<string, string>();
  private pendingSave = false;
  private saveCurrentConversationChain: Promise<void> = Promise.resolve();
  private readonly backgroundConversationSaveChains = new Map<string, Promise<void>>();
  /** Notes for the agent about out-of-band workspace changes (e.g. turn resets), per conversation. */
  private readonly pendingWorkspaceNotes = new Map<string, string[]>();

  private hooks: ConversationSessionHooks = {
    getCurrentWorkspaceId: () => null,
    getSpeechSettings: () => ({ enabled: false, voice: '', speed: 1 }),
  };
  /** Latest config so llama stop events can match the active managed local source. */
  private lastConfig: AppConfig | null = null;

  constructor() {
    effect(() => {
      const convId = this.activeConversationId();
      const messages = this.messages();
      const pending = convId ? this.pendingIds().has(convId) : false;
      if (!convId || !pending) {
        return;
      }
      untracked(() => this.syncLiveHitlTrailIntoStreamParts(messages));
    });

    this.electron.chunk$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, delta, streamTag }) => {
      const toolRunInProgress = this.toolRunIds().size > 0;
      if (shouldIgnoreWhitespaceOnlyModelChunkDuringTool(delta, toolRunInProgress)) {
        return;
      }
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => {
          const next = appendStreamPart(prev, streamTag, delta);
          const speech = this.hooks.getSpeechSettings();
          if (speech.enabled) {
            const rawPrimary = primaryAssistantTextFromParts(next);
            void this.tts.feedStreamingAssistantText(rawPrimary, speech.voice, speech.speed);
          }
          return next;
        });
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.setBackgroundParts(conversationId, appendStreamPart(prev, streamTag, delta));
      }
    });

    this.electron.toolReadChunk$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, delta }) => {
      const mergeRead = (prev: StreamPart[]) => appendAndMergeReadToolPreviewChunk(prev, delta);
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => {
          const next = mergeRead(prev);
          this.syncChainTextFromReadToolTrail(next);
          return next;
        });
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.setBackgroundParts(conversationId, mergeRead(prev));
      }
    });

    this.electron.toolExecChunk$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, delta, streamTag, label }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => appendStreamPart(prev, streamTag, delta, label ?? ''));
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.setBackgroundParts(conversationId, appendStreamPart(prev, streamTag, delta, label ?? ''));
      }
    });

    this.electron.toolExecComplete$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, streamTag, exitCode, outputExcerpt, outcome }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) =>
          markToolExecStreamComplete(prev, streamTag, exitCode, outputExcerpt, outcome),
        );
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.setBackgroundParts(
          conversationId,
          markToolExecStreamComplete(prev, streamTag, exitCode, outputExcerpt, outcome),
        );
      }
    });

    // `file_journal` rows are persisted by main as they stream (no renderer append), and agent
    // edits land on disk directly; the turn's edited files arrive with `done$`.

    this.electron.acceptCommand$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'accept_command', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact);
    });

    this.electron.deleteConfirm$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId) return;
      const batchOk = Array.isArray(payload.entries) && payload.entries.length > 0;
      const singleOk = typeof payload.relativePath === 'string' && payload.relativePath.trim().length > 0;
      if (!batchOk && !singleOk) return;
      const artifact = { role: 'delete_confirm', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact);
    });

    this.electron.plannerProgress$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, planner }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingPlanner.set(planner);
      } else {
        this.backgroundStreamPlanner.set(conversationId, planner);
      }
    });

    this.electron.planConfirm$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'plan_confirm', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact, { mergeBackgroundTrail: false });
    });

    this.electron.agentQuestion$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'agent_question', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact, { mergeBackgroundTrail: false });
    });

    this.electron.themeProposal$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'theme_proposal', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact, { mergeBackgroundTrail: false });
    });

    this.electron.llmStatus$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, status }) => {
      const src = (status.source ?? 'agent').toLowerCase();
      if (conversationId !== this.activeConversationId()) {
        if (src === 'tool') {
          this.syncBackgroundToolRun(conversationId, status);
        }
        return;
      }
      if (src === 'tool') {
        this.syncToolRunId(status);
        queueMicrotask(() => {
          if (conversationId !== this.activeConversationId()) return;
          this.applyToolLlmStatus(status);
        });
        return;
      }
      if (isClaraOuterBriefStreamTag(status.streamTag)) {
        this.streamingParts.update((prev) => upsertClaraOuterBriefStreamPart(prev, status));
        return;
      }
      this.upsertChainMessage(status);
    });

    this.electron.finalText$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, text }) => {
      this.pendingFinalText.set(conversationId, text);
      if (conversationId === this.activeConversationId()) {
        this.streamingFinalText.set(text);
      } else {
        this.bumpBackgroundStream();
      }
    });

    this.electron.clearPrimaryStream$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => clearPrimaryStreamParts(prev));
        return;
      }
      const prev = this.backgroundStreamParts.get(conversationId) ?? [];
      this.setBackgroundParts(conversationId, clearPrimaryStreamParts(prev));
    });

    this.electron.promotePrimaryToNudge$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId }) => {
      this.pendingFinalText.delete(conversationId);
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => promotePrimaryToNudgeParts(prev));
        this.streamingFinalText.set(undefined);
        return;
      }
      const prev = this.backgroundStreamParts.get(conversationId) ?? [];
      this.setBackgroundParts(conversationId, promotePrimaryToNudgeParts(prev));
    });

    this.electron.done$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, outcome, editedFiles }) => {
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
      const persistAssistant = outcome === 'completed';

      if (planner?.phase === 'complete') {
        this.hooks.onPlannerComplete?.(conversationId);
      }

      if (conversationId === this.activeConversationId()) {
        this.toolRunIds.set(new Set());
        this.streamingParts.set([]);
        this.streamingPlanner.set(null);
        this.streamingFinalText.set(undefined);
        if (persistAssistant && turn) {
          this.pushMessage(
            'assistant',
            turn.text,
            turn.toolStreams,
            turn.reasoningStreams,
            turn.auxiliaryStreamTimeline,
            planner ?? undefined,
            undefined,
            editedFiles,
          );
          const speech = this.hooks.getSpeechSettings();
          if (speech.enabled) {
            const streamedPrimary = primaryAssistantTextFromParts(parts);
            const ttsText = pickTtsFlushText(streamedPrimary, turn.text);
            if (ttsText.trim()) {
              void this.tts.flushStreamingAssistantText(ttsText, speech.voice, speech.speed);
            }
          }
          void this.persistActiveAssistantTurnThenMaybeAutoTitle(conversationId).catch((err) =>
            console.error('[ConversationSession] persist assistant / auto-title failed', err),
          );
        }
      } else {
        this.clearBackgroundStream(conversationId);
        if (persistAssistant && turn) {
          void this.saveMessageToConversation(
            conversationId,
            turn.text,
            turn.toolStreams,
            turn.reasoningStreams,
            turn.auxiliaryStreamTimeline,
            planner ?? undefined,
            editedFiles,
          )
            .then(() => this.applyMaybeAutoTitleFromMain(conversationId))
            .catch((err) => console.error('[ConversationSession] background save / auto-title failed', err));
        }
      }
    });

    this.electron.config$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((config) => {
      this.lastConfig = config;
    });

    merge(this.electron.llamaServerLifecycle$, this.electron.llamaServerProcessExit$)
      .pipe(
        filter((e) => this.isActiveManagedLlamaStopEvent(e)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.abortPendingBecauseLlamaStopped();
      });
  }

  bindHooks(hooks: ConversationSessionHooks): void {
    this.hooks = hooks;
  }

  getActiveConversation(): Conversation | null {
    return this.activeConversation;
  }

  patchActiveConversationTitle(id: string, title: string): void {
    if (this.activeConversation?.id === id) {
      this.activeConversation.title = title;
      this.activeConversation.customTitle = true;
    }
  }

  addPending(id: string): void {
    this.pendingIds.update((s) => new Set(s).add(id));
  }

  removePending(id: string): void {
    this.pendingIds.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  getPendingStreamIdsForWorkspace(workspaceId: string | null): string[] {
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

  async abortPendingStreamsForWorkspace(workspaceId: string | null): Promise<void> {
    const ids = this.getPendingStreamIdsForWorkspace(workspaceId);
    await Promise.all(ids.map((id) => this.electron.abortMessage(id)));
  }

  async loadConversationsForWorkspace(currentWorkspaceId: string | null): Promise<void> {
    const wsId = currentWorkspaceId;
    const config = await this.electron.loadConfig();
    const list = await this.electron.getConversations(wsId);
    this.conversations.set(list);

    if (list.length === 0) {
      await this.onNewConversation(currentWorkspaceId);
    } else {
      const key = wsId ?? '';
      const remembered = config.lastActiveConversationByWorkspaceId?.[key];
      const match = remembered ? list.find((c) => c.id === remembered) : undefined;
      const conv = match ?? list[0];
      await this.loadConversation(conv.id, conv.workspaceId);
    }
  }

  async refreshConversationList(currentWorkspaceId: string | null): Promise<void> {
    const list = await this.electron.getConversations(currentWorkspaceId);
    this.conversations.set(list);
  }

  async onNewConversation(currentWorkspaceId: string | null): Promise<void> {
    if (this.creatingConversation()) {
      return;
    }
    this.creatingConversation.set(true);
    try {
      await this.saveCurrentConversation();
      const conv = await this.electron.newConversation(currentWorkspaceId);
      this.snapshotActiveStreamToBackground();
      this.activeConversation = conv;
      this.activeConversationId.set(conv.id);
      this.messages.set([]);
      this.toolRunIds.set(new Set());
      this.streamingParts.set([]);
      this.streamingPlanner.set(null);
      this.streamingFinalText.set(undefined);
      await this.refreshConversationList(currentWorkspaceId);
      await this.rememberLastActiveForWorkspace(conv);
      this.chatHubView.set('activeChat');
    } finally {
      this.creatingConversation.set(false);
    }
  }

  async onSelectConversation(id: string, currentWorkspaceId: string | null): Promise<void> {
    if (id === this.activeConversationId()) return;
    await this.saveCurrentConversation();
    const conv = this.conversations().find((c) => c.id === id);
    const convWorkspaceId = conv?.workspaceId ?? currentWorkspaceId;
    await this.loadConversation(id, convWorkspaceId);
    this.chatHubView.set('activeChat');
  }

  async loadConversation(
    id: string,
    workspaceId?: string | null,
    loadOpts?: { skipPythonResync?: boolean },
  ): Promise<void> {
    const skipPython =
      loadOpts?.skipPythonResync !== undefined
        ? loadOpts.skipPythonResync
        : this.pendingIds().has(id);
    const conv = await this.electron.loadConversation(id, workspaceId, { skipPythonResync: skipPython });
    this.snapshotActiveStreamToBackground();
    this.activeConversation = conv;
    this.activeConversationId.set(conv.id);
    this.messages.set(conv.messages);
    this.toolRunIds.set(new Set());
    const stillStreaming = this.pendingIds().has(conv.id);
    if (stillStreaming) {
      const bgParts = this.backgroundStreamParts.get(conv.id) ?? [];
      this.streamingParts.set(bgParts.length ? [...bgParts] : []);
      this.clearBackgroundStream(conv.id);
      this.streamingFinalText.set(this.pendingFinalText.get(conv.id));
    } else {
      this.streamingParts.set([]);
      this.clearBackgroundStream(conv.id);
      this.streamingFinalText.set(undefined);
      const abandoned = abandonStaleHitlMessages(conv.messages);
      if (abandoned !== conv.messages) {
        this.messages.set(abandoned);
        if (this.activeConversation) {
          this.activeConversation.messages = [...abandoned];
          this.pendingSave = true;
        }
        this.autoSave();
      }
    }
    // After transcript + stream signals match this conversation, so load hooks do not
    // observe the previous chat's messages under the new id.
    this.hooks.onConversationLoaded?.(conv.id);

    await this.rememberLastActiveForWorkspace(conv);
  }

  pushMessage(
    role: 'user' | 'assistant',
    text: string,
    toolStreams?: StreamPart[],
    reasoningStreams?: StreamPart[],
    auxiliaryStreamTimeline?: StreamPart[],
    planner?: PlannerProgress,
    structuredContent?: readonly ChatStructuredContentPart[],
    editedFiles?: readonly TurnEditedFile[],
  ): string | undefined {
    let nextMessage: ChatMessage;
    if (role === 'user') {
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      nextMessage = structuredContent?.length
        ? { role, text, id, structuredContent }
        : { role, text, id };
    } else {
      const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text };
      if (toolStreams?.length) assistant.toolStreams = toolStreams;
      if (reasoningStreams?.length) assistant.reasoningStreams = reasoningStreams;
      if (auxiliaryStreamTimeline?.length) assistant.auxiliaryStreamTimeline = auxiliaryStreamTimeline;
      if (planner) assistant.planner = planner;
      if (editedFiles?.length) assistant.editedFiles = [...editedFiles];
      nextMessage = assistant;
    }
    this.messages.update((prev) => [...prev, nextMessage]);
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
    }
    return nextMessage.role === 'user' ? nextMessage.id : undefined;
  }

  /**
   * Mirror updated turn-file statuses (after a reset) onto the assistant message that closes the
   * turn started by `userMessageId`, then save.
   */
  applyTurnEditedFiles(userMessageId: string, files: readonly TurnEditedFile[]): void {
    const msgs = this.messages();
    const userIdx = msgs.findIndex((m) => m.role === 'user' && m.id === userMessageId);
    if (userIdx < 0) {
      return;
    }
    let assistantIdx = -1;
    for (let i = userIdx + 1; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'user') {
        break;
      }
      if (m.role === 'assistant') {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx < 0) {
      return;
    }
    this.messages.update((prev) => {
      const copy = [...prev];
      const m = copy[assistantIdx];
      if (m?.role === 'assistant') {
        copy[assistantIdx] = { ...m, editedFiles: [...files] };
      }
      return copy;
    });
    this.markMessagesDirtyAndAutoSave();
  }

  /** Queue a note sent as `workspace_notes` with the next chat request of `conversationId`. */
  queueWorkspaceNote(conversationId: string, note: string): void {
    const text = note.trim();
    if (!conversationId || !text) {
      return;
    }
    const list = this.pendingWorkspaceNotes.get(conversationId) ?? [];
    list.push(text);
    this.pendingWorkspaceNotes.set(conversationId, list);
  }

  /** Remove and return the queued workspace notes for `conversationId`. */
  takeWorkspaceNotes(conversationId: string): string[] {
    const list = this.pendingWorkspaceNotes.get(conversationId) ?? [];
    this.pendingWorkspaceNotes.delete(conversationId);
    return list;
  }

  /** Put notes back at the front of the queue (send failed before reaching main). */
  requeueWorkspaceNotes(conversationId: string, notes: readonly string[]): void {
    if (notes.length === 0) {
      return;
    }
    const rest = this.pendingWorkspaceNotes.get(conversationId) ?? [];
    this.pendingWorkspaceNotes.set(conversationId, [...notes, ...rest]);
  }

  applyRestoredMessages(messages: ChatMessage[]): void {
    this.messages.set([...messages]);
    if (this.activeConversation) {
      this.activeConversation.messages = [...messages];
      this.pendingSave = false;
    }
    this.streamingParts.set([]);
    this.streamingPlanner.set(null);
    this.streamingFinalText.set(undefined);
    this.toolRunIds.set(new Set());
  }

  markMessagesDirtyAndAutoSave(): void {
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
      this.autoSave();
    }
  }

  updateConversationMeta(id: string, changes: Partial<ConversationMeta>): void {
    this.conversations.update((list) => {
      const updated = list.map((c) => (c.id === id ? { ...c, ...changes } : c));
      updated.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return updated;
    });
  }

  clearActiveConversationAfterDelete(): void {
    this.activeConversation = null;
  }

  async saveCurrentConversation(): Promise<void> {
    const p = this.saveCurrentConversationChain.then(() => this.flushSaveCurrentConversation());
    this.saveCurrentConversationChain = p.catch((err) => {
      console.error('[ConversationSession] saveCurrentConversation chain failed:', err);
    });
    return p;
  }

  prepareForSend(conversationId: string): void {
    this.addPending(conversationId);
    this.toolRunIds.set(new Set());
    this.streamingParts.set([]);
    this.streamingPlanner.set(null);
    this.streamingFinalText.set(undefined);
  }

  resetStreamUiOnSendFailure(conversationId: string): void {
    this.removePending(conversationId);
  }

  /**
   * True when a lifecycle/process-exit event means the active managed local llama chat server is down.
   * Embed-only exits are ignored; generation can continue on chat.
   */
  private isActiveManagedLlamaStopEvent(
    e: LlamaServerLifecycleEvent | LlamaServerProcessExitEvent,
  ): boolean {
    const loc = this.lastConfig ? findManagedLocalLlamaLocation(this.lastConfig) : null;
    const activeId = loc?.model.id;
    if (!activeId || e.modelId !== activeId) {
      return false;
    }
    if ('phase' in e) {
      return e.phase === 'stopped';
    }
    return e.stream === 'chat';
  }

  /**
   * Llama chat died or was stopped: cancel in-flight turns and reset the composer Stop button
   * even if the SSE `done` event never arrives (hung Python/llama HTTP).
   */
  private abortPendingBecauseLlamaStopped(): void {
    const ids = [...this.pendingIds()];
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      void this.electron.abortMessage(id);
      this.settleInFlightAsAborted(id);
    }
  }

  private settleInFlightAsAborted(conversationId: string): void {
    this.removePending(conversationId);
    this.pendingFinalText.delete(conversationId);
    this.backgroundStreamPlanner.delete(conversationId);
    this.clearBackgroundStream(conversationId);
    if (conversationId === this.activeConversationId()) {
      this.toolRunIds.set(new Set());
      this.streamingParts.set([]);
      this.streamingPlanner.set(null);
      this.streamingFinalText.set(undefined);
    }
  }

  private async flushSaveCurrentConversation(): Promise<void> {
    if (!this.activeConversation) {
      return;
    }
    while (this.pendingSave) {
      this.pendingSave = false;
      this.activeConversation.messages = [...this.messages()];
      this.activeConversation.updatedAt = new Date().toISOString();
      await this.electron.saveConversation(this.activeConversation);
    }
  }

  private autoSave(): void {
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
    editedFiles?: readonly TurnEditedFile[],
  ): Promise<void> {
    const prev = this.backgroundConversationSaveChains.get(conversationId) ?? Promise.resolve();
    const mine = prev.then(async () => {
      try {
        const convMeta = this.conversations().find((c) => c.id === conversationId);
        const workspaceId = convMeta?.workspaceId ?? this.hooks.getCurrentWorkspaceId();
        const conv = await this.electron.readConversationFromDisk(conversationId, workspaceId);
        const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text };
        if (toolStreams?.length) assistant.toolStreams = toolStreams;
        if (reasoningStreams?.length) assistant.reasoningStreams = reasoningStreams;
        if (auxiliaryStreamTimeline?.length) assistant.auxiliaryStreamTimeline = auxiliaryStreamTimeline;
        if (planner) assistant.planner = planner;
        if (editedFiles?.length) assistant.editedFiles = [...editedFiles];
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
      mine.catch((err) => console.error('[ConversationSession] background conversation save failed:', err)),
    );
    return mine;
  }

  private async persistArtifactToConversation(
    conversationId: string,
    message: ChatMessage,
  ): Promise<void> {
    const prev = this.backgroundConversationSaveChains.get(conversationId) ?? Promise.resolve();
    const mine = prev.then(async () => {
      try {
        const convMeta = this.conversations().find((c) => c.id === conversationId);
        const workspaceId = convMeta?.workspaceId ?? this.hooks.getCurrentWorkspaceId();
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
      mine.catch((err) => console.error('[ConversationSession] background artifact save failed:', err)),
    );
    return mine;
  }

  private bumpConversation(id: string): void {
    this.updateConversationMeta(id, { updatedAt: new Date().toISOString() });
  }

  private async rememberLastActiveForWorkspace(conv: Conversation): Promise<void> {
    const key = conv.workspaceId ?? '';
    await this.electron.setLastActiveConversation(key, conv.id);
  }

  appendLocalHitlArtifact(conversationId: string, artifact: ChatMessage): void {
    this.appendHitlArtifact(conversationId, artifact);
  }

  private appendHitlArtifact(
    conversationId: string,
    artifact: ChatMessage,
    opts?: { mergeBackgroundTrail?: boolean },
  ): void {
    const mergeBackgroundTrail = opts?.mergeBackgroundTrail !== false;
    if (conversationId !== this.activeConversationId()) {
      void this.persistArtifactToConversation(conversationId, artifact);
      if (this.pendingIds().has(conversationId)) {
        this.backgroundAwaitingReview.add(conversationId);
        this.bumpBackgroundStream();
      }
      if (mergeBackgroundTrail) {
        this.mergeHitlTrailIntoBackgroundStream(conversationId, artifact as HitlTrailArtifact);
      }
      return;
    }
    this.messages.update((prev) => [...prev, artifact]);
    if (this.activeConversation) {
      this.activeConversation.messages = [...this.messages()];
      this.pendingSave = true;
    }
  }

  private syncLiveHitlTrailIntoStreamParts(messages: readonly ChatMessage[]): void {
    const live = resolveLiveAssistantTurn(buildChatDisplayRows([...messages]));
    if (!live) {
      return;
    }
    const artifacts = hitlArtifactsExcludingPlanConfirm(live.artifacts) as HitlTrailArtifact[];
    this.streamingParts.update((prev) => mergeHitlTrailIntoAuxiliaryTimeline(prev, artifacts));
  }

  private mergeHitlTrailIntoBackgroundStream(
    conversationId: string,
    artifact: HitlTrailArtifact,
  ): void {
    const prev = this.backgroundStreamParts.get(conversationId);
    if (!prev) {
      return;
    }
    this.setBackgroundParts(
      conversationId,
      mergeHitlTrailIntoAuxiliaryTimeline(prev, [artifact]),
    );
  }

  /**
   * Persist the live stream signals (which only track the active conversation) into the
   * per-conversation background maps before the active conversation changes. Without this,
   * switching away from a still-streaming conversation drops its accumulated reasoning/tool
   * stream text: post-switch chunks route to the background maps, but the parts collected while
   * the conversation was active live only in the `streamingParts`/`streamingPlanner` signals and
   * would be cleared on the next switch.
   */
  private snapshotActiveStreamToBackground(): void {
    const oldId = this.activeConversationId();
    if (!oldId || !this.pendingIds().has(oldId)) {
      return;
    }
    const liveParts = this.streamingParts();
    if (liveParts.length) {
      this.setBackgroundParts(oldId, [...liveParts]);
    } else {
      this.clearBackgroundStream(oldId);
    }
    if (this.activeAwaitingReview()) {
      this.backgroundAwaitingReview.add(oldId);
      this.bumpBackgroundStream();
    }
    const livePlanner = this.streamingPlanner();
    if (livePlanner) {
      this.backgroundStreamPlanner.set(oldId, livePlanner);
    } else {
      this.backgroundStreamPlanner.delete(oldId);
    }
  }

  private setBackgroundParts(conversationId: string, parts: StreamPart[]): void {
    this.backgroundStreamParts.set(conversationId, parts);
    this.bumpBackgroundStream();
  }

  /** Drop every background stream record for `conversationId` (turn ended, or it is active now). */
  private clearBackgroundStream(conversationId: string): void {
    this.backgroundStreamParts.delete(conversationId);
    this.backgroundToolRuns.delete(conversationId);
    this.backgroundAwaitingReview.delete(conversationId);
    this.bumpBackgroundStream();
  }

  private bumpBackgroundStream(): void {
    this.backgroundStreamVersion.update((v) => v + 1);
  }

  private syncBackgroundToolRun(conversationId: string, status: LlmStatus): void {
    if (!this.pendingIds().has(conversationId)) {
      return;
    }
    const runs = new Map(this.backgroundToolRuns.get(conversationId) ?? []);
    if (status.state === 'running') {
      runs.set(status.id, status.label ?? '');
    } else if (status.state === 'complete' || status.state === 'error') {
      runs.delete(status.id);
    } else {
      return;
    }
    this.backgroundToolRuns.set(conversationId, runs);
    this.bumpBackgroundStream();
  }

  private syncToolRunId(status: LlmStatus): void {
    if (status.state === 'running') {
      this.toolRunIds.update((s) => new Set(s).add(status.id));
      return;
    }
    if (status.state === 'complete' || status.state === 'error') {
      this.toolRunIds.update((s) => {
        const next = new Set(s);
        next.delete(status.id);
        return next;
      });
    }
  }

  private applyToolLlmStatus(status: LlmStatus): void {
    this.syncToolRunId(status);
    this.streamingParts.update((prev) => {
      const next = upsertToolTrailStatusStreamPart(prev, status);
      this.upsertChainMessage(status, this.chainTextForToolStatus(next, status));
      return next;
    });
  }

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
}
