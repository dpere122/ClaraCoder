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
  ConversationMessage,
  ConversationMeta,
  HitlTrailArtifact,
  LlamaServerLifecycleEvent,
  LlamaServerProcessExitEvent,
  LlmStatus,
  PlannerProgress,
  StreamPart,
  SubagentOutcome,
  SubagentStartedEvent,
  TurnEditedFile,
  TurnEndedEarly,
  TurnGenerationStats,
} from '@shared/index';
import {
  buildTurnFeed,
  clearPrimaryStreamParts,
  promotePrimaryToNudgeParts,
  findManagedLocalLlamaLocation,
  isClaraOuterBriefStreamTag,
  isInFlightToolPart,
  primaryAssistantTextFromParts,
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
  inFlightToolSpinnerKind,
  resolveLiveAssistantTurn,
  resolvePrimaryStreamLiveText,
  resolveTurnActivity,
  turnHasPendingHitlArtifacts,
  type ChatMessage,
  type TurnActivity,
} from '../chat/chat-box/chat-box';
import { LiveTurnActivityService } from '../chat/chat-box/live-turn-activity';
import { toolSpinnerKind } from '../chat/chat-box/tool-spinner-kind';
import { GenerationRateService } from '../chat/chat-box/generation-rate';
import { ElectronService, type DoneMessage } from '../../core/electron.service';
import { TtsPlaybackService } from '../../core/tts-playback.service';
import { buildAssistantTurnFromStreamParts, type AssistantTurnPayload } from './app-assistant-turn';
import {
  appendStreamPart,
  markToolExecStreamComplete,
  mergeHitlTrailIntoLiveStreamParts,
  upsertClaraOuterBriefStreamPart,
  upsertToolTrailStatusStreamPart,
} from './app-stream-parts';
import { abandonStaleHitlMessages } from './abandon-stale-hitl';
import {
  attachTurnEditedFiles,
  cancelSubagentApprovals,
  settleInFlightStreamParts,
  settleLiveTurnMessages,
} from './ended-turn';
import { filter, merge, type MonoTypeOperatorFunction } from 'rxjs';

/** How long an interrupt waits for the old turn's `message-done` before sending anyway. */
const INTERRUPT_DRAIN_TIMEOUT_MS = 5000;

/** First conversation the user can type in (sub-agent conversations are read-only). */
export function firstTopLevelConversation(list: readonly ConversationMeta[]): ConversationMeta {
  return list.find((c) => !c.parentConversationId) ?? list[0]!;
}

/** One sub-agent the main agent spawned this session (drives the sub-agent dock). */
export interface SubagentRun {
  conversationId: string;
  parentConversationId: string;
  /** The parent user message whose turn spawned it. */
  parentTurnId?: string;
  name: string;
  task: string;
  /** `Date.now()` when its stream started. */
  startedAt: number;
  endedAt?: number;
  /** Set once its turn ended. */
  outcome?: SubagentOutcome;
  /** Status id of the parent's `spawn_subagent` pill. */
  statusId?: string;
  /** Started in the background: the parent agent kept working instead of waiting for it. */
  background?: boolean;
}

/** An interrupted turn whose stream is being stopped; its late events are dropped until its done. */
interface DrainingTurn {
  /** The interrupted turn's user message id (may be empty for turns sent without one). */
  turnId: string;
  resolve: () => void;
  settled: Promise<void>;
}

/** Extra fields of a persisted assistant message beyond {@link AssistantTurnPayload}. */
interface AssistantTurnExtras {
  planner?: PlannerProgress;
  editedFiles?: readonly TurnEditedFile[];
  generation?: TurnGenerationStats;
  endedEarly?: TurnEndedEarly;
}

function assistantMessageFromTurn(
  turn: AssistantTurnPayload,
  extras: AssistantTurnExtras,
): Extract<ChatMessage, { role: 'assistant' }> {
  const assistant: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', text: turn.text };
  if (turn.toolStreams?.length) assistant.toolStreams = turn.toolStreams;
  if (turn.reasoningStreams?.length) assistant.reasoningStreams = turn.reasoningStreams;
  if (turn.auxiliaryStreamTimeline?.length) assistant.auxiliaryStreamTimeline = turn.auxiliaryStreamTimeline;
  if (extras.planner) assistant.planner = extras.planner;
  if (extras.editedFiles?.length) assistant.editedFiles = [...extras.editedFiles];
  if (extras.generation) assistant.generation = extras.generation;
  if (extras.endedEarly) assistant.endedEarly = extras.endedEarly;
  return assistant;
}
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
  /** `contextTokens`: the meter's last reading, when Python kept the conversation's checkpoint. */
  onConversationLoaded?: (conversationId: string, contextTokens?: number) => void;
}

@Injectable({ providedIn: 'root' })
export class ConversationSessionService {
  private readonly electron = inject(ElectronService);
  private readonly tts = inject(TtsPlaybackService);
  private readonly liveTurnActivity = inject(LiveTurnActivityService);
  private readonly generationRate = inject(GenerationRateService);
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
  /** Set while a sub-agent conversation is open: the conversation that spawned it (read-only view). */
  readonly activeParentConversationId = signal<string | null>(null);
  /** Sub-agents spawned this session whose parent turn is still live, oldest first. */
  readonly subagentRuns = signal<readonly SubagentRun[]>([]);
  /** Sub-agent id -> request ids of its approval cards waiting in the parent's dock. */
  readonly pendingSubagentApprovals = signal<ReadonlyMap<string, readonly string[]>>(new Map());
  /** Conversations whose interrupted turn is still being stopped (Send waits on these). */
  readonly drainingConversationIds = signal<ReadonlySet<string>>(new Set());

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
            toolKind: inFlightToolSpinnerKind(parts, toolsActive),
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
          // The latest live run names the spinner; parts are the fallback once runs settle.
          toolKind:
            latestRunLabel != null
              ? toolSpinnerKind(latestRunLabel, '')
              : inFlightToolSpinnerKind(parts, toolsActive),
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
  /** User message id of each conversation's live turn, matched against `message-done`. */
  private readonly liveTurnIds = new Map<string, string>();
  /**
   * Turns the renderer already ended (interrupted, discarded, settled after a llama stop). Their
   * late `message-done` must not touch the turn the conversation shows now.
   */
  private readonly settledTurnIds = new Set<string>();
  private readonly drainingTurns = new Map<string, DrainingTurn>();
  /** Conversations deleted this session: a save still queued for one is dropped. */
  private readonly deletedConversationIds = new Set<string>();

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

    this.electron.chunk$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, delta, streamTag }) => {
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

    this.electron.toolReadChunk$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, delta, statusId }) => {
      const mergeRead = (prev: StreamPart[]) => appendAndMergeReadToolPreviewChunk(prev, delta, statusId);
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => {
          const next = mergeRead(prev);
          this.syncChainTextFromReadToolTrail(next, statusId);
          return next;
        });
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.setBackgroundParts(conversationId, mergeRead(prev));
      }
    });

    this.electron.toolExecChunk$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, delta, streamTag, label }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => appendStreamPart(prev, streamTag, delta, label ?? ''));
      } else {
        const prev = this.backgroundStreamParts.get(conversationId) ?? [];
        this.setBackgroundParts(conversationId, appendStreamPart(prev, streamTag, delta, label ?? ''));
      }
    });

    this.electron.toolExecComplete$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, streamTag, exitCode, outputExcerpt, outcome }) => {
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

    this.electron.acceptCommand$.pipe(this.unfencedOrSubagent(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'accept_command', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact);
      this.trackSubagentApproval(payload.subagent?.conversationId, payload.requestId);
    });

    this.electron.deleteConfirm$.pipe(this.unfencedOrSubagent(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId) return;
      const batchOk = Array.isArray(payload.entries) && payload.entries.length > 0;
      const singleOk = typeof payload.relativePath === 'string' && payload.relativePath.trim().length > 0;
      if (!batchOk && !singleOk) return;
      const artifact = { role: 'delete_confirm', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact);
      this.trackSubagentApproval(payload.subagent?.conversationId, payload.requestId);
    });

    this.electron.plannerProgress$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, planner }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingPlanner.set(planner);
      } else {
        this.backgroundStreamPlanner.set(conversationId, planner);
      }
    });

    this.electron.planConfirm$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'plan_confirm', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact, { mergeBackgroundTrail: false });
    });

    this.electron.agentQuestion$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'agent_question', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact, { mergeBackgroundTrail: false });
    });

    this.electron.themeProposal$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, payload }) => {
      if (payload.version !== 1 || !payload.requestId || !payload.title) return;
      const artifact = { role: 'theme_proposal', payload, reviewStatus: 'pending' as const } satisfies ChatMessage;
      this.appendHitlArtifact(conversationId, artifact, { mergeBackgroundTrail: false });
    });

    this.electron.llmStatus$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, status }) => {
      const src = (status.source ?? 'agent').toLowerCase();
      if (conversationId !== this.activeConversationId()) {
        if (src === 'tool' && this.pendingIds().has(conversationId)) {
          this.syncBackgroundToolRun(conversationId, status);
          // Keep the pill in the background turn too, so a turn that streams in the background
          // (a sub-agent, a chat the user switched away from) saves and previews its tool calls.
          const prev = this.backgroundStreamParts.get(conversationId) ?? [];
          this.setBackgroundParts(conversationId, upsertToolTrailStatusStreamPart(prev, status));
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

    this.electron.finalText$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId, text }) => {
      this.pendingFinalText.set(conversationId, text);
      if (conversationId === this.activeConversationId()) {
        this.streamingFinalText.set(text);
      } else {
        this.bumpBackgroundStream();
      }
    });

    this.electron.clearPrimaryStream$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId }) => {
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => clearPrimaryStreamParts(prev));
        return;
      }
      const prev = this.backgroundStreamParts.get(conversationId) ?? [];
      this.setBackgroundParts(conversationId, clearPrimaryStreamParts(prev));
    });

    this.electron.promotePrimaryToNudge$.pipe(this.unfenced(), takeUntilDestroyed(this.destroyRef)).subscribe(({ conversationId }) => {
      this.pendingFinalText.delete(conversationId);
      if (conversationId === this.activeConversationId()) {
        this.streamingParts.update((prev) => promotePrimaryToNudgeParts(prev));
        this.streamingFinalText.set(undefined);
        return;
      }
      const prev = this.backgroundStreamParts.get(conversationId) ?? [];
      this.setBackgroundParts(conversationId, promotePrimaryToNudgeParts(prev));
    });

    this.electron.done$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((done) => this.onTurnDone(done));

    this.electron.subagentStarted$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((started) => this.onSubagentStarted(started));

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

  /**
   * A turn of `conversationId` can still run in main while this renderer does not know it (the
   * renderer reloaded mid-turn). Mark it live again so its stream, its done and its approval
   * cards land in this renderer, and return it. Text streamed before the reload is not replayed.
   */
  private async rejoinLiveTurn(
    conversationId: string,
  ): Promise<{ userMessageId: string; waitingCards: { channel: string; payload: unknown }[] } | null> {
    if (this.pendingIds().has(conversationId)) {
      return null;
    }
    const live = await this.electron.getLiveTurn(conversationId);
    if (!live || this.pendingIds().has(conversationId)) {
      return null;
    }
    this.addPending(conversationId);
    this.generationRate.startTurn(conversationId);
    this.beginLiveTurn(conversationId, live.userMessageId || undefined);
    return live;
  }

  /** Remember the user message id of `conversationId`'s live turn (matched against its done). */
  beginLiveTurn(conversationId: string, userMessageId: string | undefined): void {
    if (userMessageId) {
      this.liveTurnIds.set(conversationId, userMessageId);
    } else {
      this.liveTurnIds.delete(conversationId);
    }
  }

  /**
   * The user sent a message while `conversationId` was still answering: end the live turn now as
   * interrupted (its partial reply is kept) and drop that stream's late events until its done
   * arrives. Await {@link drainInterruptedTurn} before sending the new message.
   */
  interruptLiveTurn(conversationId: string): void {
    if (!this.pendingIds().has(conversationId) || this.drainingTurns.has(conversationId)) {
      return;
    }
    // Chunks still queued for the next frame belong to the turn being interrupted.
    this.electron.flushPendingStreamBatch();
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    this.drainingTurns.set(conversationId, { turnId: this.liveTurnIds.get(conversationId) ?? '', resolve, settled });
    this.drainingConversationIds.update((s) => new Set(s).add(conversationId));
    this.endLiveTurnLocally(conversationId, 'interrupted');
  }

  /**
   * Stop the interrupted turn's stream and wait (bounded) for its done, so its late events never
   * reach the next turn and its edited files land on the interrupted reply.
   */
  async drainInterruptedTurn(conversationId: string): Promise<void> {
    const drain = this.drainingTurns.get(conversationId);
    if (!drain) {
      return;
    }
    try {
      // Main aborts the fetch and has told Python to stop before this resolves.
      await this.electron.abortMessage(conversationId);
    } catch {
      // The stream already ended; its done is on its way or already handled.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drain.settled,
      new Promise<void>((r) => {
        timer = setTimeout(r, INTERRUPT_DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (this.drainingTurns.get(conversationId) === drain) {
      this.drainingTurns.delete(conversationId);
      this.drainingConversationIds.update((s) => {
        const next = new Set(s);
        next.delete(conversationId);
        return next;
      });
    }
  }

  /** Drop the live turn of `conversationId` without saving it (restore / delete replace it). */
  discardLiveTurn(conversationId: string): void {
    if (this.pendingIds().has(conversationId)) {
      this.endLiveTurnLocally(conversationId, null);
    }
  }

  /** Before deleting `id`: drop its live turn and its sub-agents' (nothing of them is saved). */
  prepareDeleteConversation(id: string): void {
    const ids = [id, ...this.conversations().filter((c) => c.parentConversationId === id).map((c) => c.id)];
    for (const convId of ids) {
      this.deletedConversationIds.add(convId);
      this.discardLiveTurn(convId);
    }
    this.forgetSubagentRuns(ids);
  }

  /** Conversations main deleted (e.g. sub-agents of turns a restore removed): drop them here too. */
  forgetConversations(ids: readonly string[]): void {
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      this.deletedConversationIds.add(id);
      this.discardLiveTurn(id);
    }
    const gone = new Set(ids);
    this.conversations.update((list) => list.filter((c) => !gone.has(c.id)));
    this.forgetSubagentRuns(ids);
  }

  /** True when `conversationId` is a sub-agent's (read-only) conversation. */
  isSubagentConversation(conversationId: string): boolean {
    if (conversationId === this.activeConversationId() && this.activeParentConversationId()) {
      return true;
    }
    return (
      !!this.conversations().find((c) => c.id === conversationId)?.parentConversationId ||
      // Its meta is listed only while its workspace is on screen; its run is tracked regardless.
      this.subagentRuns().some((r) => r.conversationId === conversationId)
    );
  }

  /** Live stream parts of a conversation's in-flight turn (reactive for background ones too). */
  streamPartsFor(conversationId: string): StreamPart[] {
    if (conversationId === this.activeConversationId()) {
      return this.streamingParts();
    }
    this.backgroundStreamVersion();
    return this.backgroundStreamParts.get(conversationId) ?? [];
  }

  /** Clean final text the backend sent for a conversation's in-flight turn, if any. */
  finalTextFor(conversationId: string): string | undefined {
    if (conversationId === this.activeConversationId()) {
      return this.streamingFinalText();
    }
    this.backgroundStreamVersion();
    return this.pendingFinalText.get(conversationId);
  }

  /** Sub-agent runs of `parentConversationId`'s live turn. */
  subagentRunsFor(parentConversationId: string): SubagentRun[] {
    return this.subagentRuns().filter((r) => r.parentConversationId === parentConversationId);
  }

  /** Open a conversation from inside the chat (a sub-agent's Open link, the banner's Back link). */
  openConversation(conversationId: string): void {
    void this.onSelectConversation(conversationId, this.hooks.getCurrentWorkspaceId()).catch((err) =>
      console.error('[ConversationSession] open conversation failed', err),
    );
  }

  /** Stop one sub-agent; its parent gets a partial report and keeps going. */
  stopSubagent(conversationId: string): void {
    if (this.pendingIds().has(conversationId)) {
      void this.electron.abortMessage(conversationId);
    }
  }

  /** A sub-agent approval card was answered in the parent's dock. */
  resolveSubagentApproval(requestId: string): void {
    const current = this.pendingSubagentApprovals();
    let changed = false;
    const next = new Map<string, readonly string[]>();
    for (const [childId, ids] of current) {
      const kept = ids.filter((id) => id !== requestId);
      changed ||= kept.length !== ids.length;
      if (kept.length > 0) {
        next.set(childId, kept);
      }
    }
    if (changed) {
      this.pendingSubagentApprovals.set(next);
    }
  }

  /** Cancel the pending cards in `messages` no one can answer any more (a running sub-agent's still can). */
  abandonStaleHitl(messages: ConversationMessage[]): ConversationMessage[] {
    return abandonStaleHitlMessages(messages, (m) => this.isRunningSubagentCard(m));
  }

  /** A pending card raised by a sub-agent that is still running (it can still be answered). */
  private isRunningSubagentCard(message: ConversationMessage): boolean {
    if (message.role !== 'accept_command' && message.role !== 'delete_confirm') {
      return false;
    }
    const childId = message.payload.subagent?.conversationId;
    return !!childId && this.pendingIds().has(childId);
  }

  private trackSubagentApproval(subagentConversationId: string | undefined, requestId: string): void {
    if (!subagentConversationId) {
      return;
    }
    this.pendingSubagentApprovals.update((map) => {
      const next = new Map(map);
      next.set(subagentConversationId, [...(map.get(subagentConversationId) ?? []), requestId]);
      return next;
    });
  }

  private clearSubagentApprovals(subagentConversationId: string): void {
    if (!this.pendingSubagentApprovals().has(subagentConversationId)) {
      return;
    }
    this.pendingSubagentApprovals.update((map) => {
      const next = new Map(map);
      next.delete(subagentConversationId);
      return next;
    });
  }

  private forgetSubagentRuns(conversationIds: readonly string[]): void {
    const gone = new Set(conversationIds);
    this.subagentRuns.update((runs) =>
      runs.filter((r) => !gone.has(r.conversationId) && !gone.has(r.parentConversationId)),
    );
    for (const id of conversationIds) {
      this.clearSubagentApprovals(id);
    }
  }

  /** Drop events of a conversation whose interrupted turn is draining (see {@link interruptLiveTurn}). */
  private unfenced<T extends { conversationId: string }>(): MonoTypeOperatorFunction<T> {
    return filter((e) => !this.drainingTurns.has(e.conversationId));
  }

  /**
   * Like {@link unfenced}, but a sub-agent's approval card always passes: sub-agents outlive the
   * parent turn being interrupted, so their cards are not part of that turn's late events.
   */
  private unfencedOrSubagent<T extends { conversationId: string; payload: { subagent?: unknown } }>(): MonoTypeOperatorFunction<T> {
    return filter((e) => !this.drainingTurns.has(e.conversationId) || !!e.payload.subagent);
  }

  private onSubagentStarted(started: SubagentStartedEvent): void {
    const meta = started.meta;
    const parentId = meta.parentConversationId;
    if (!parentId || this.deletedConversationIds.has(parentId)) {
      return;
    }
    // List it under its parent when the parent is in the listed workspace.
    const list = this.conversations();
    if (list.some((c) => c.id === parentId) && !list.some((c) => c.id === meta.id)) {
      this.conversations.set([meta, ...list]);
    }
    this.addPending(meta.id);
    this.generationRate.startTurn(meta.id);
    this.beginLiveTurn(meta.id, started.userMessageId);
    const run: SubagentRun = {
      conversationId: meta.id,
      parentConversationId: parentId,
      ...(meta.parentTurnId ? { parentTurnId: meta.parentTurnId } : {}),
      name: meta.title,
      task: started.task,
      startedAt: Date.now(),
      ...(started.statusId ? { statusId: started.statusId } : {}),
      ...(started.background ? { background: true } : {}),
    };
    this.subagentRuns.update((runs) => [...runs.filter((r) => r.conversationId !== meta.id), run]);
  }

  private onTurnDone(done: DoneMessage): void {
    const { conversationId, outcome, editedFiles, userMessageId } = done;
    const drain = this.drainingTurns.get(conversationId);
    if (drain && (!userMessageId || userMessageId === drain.turnId)) {
      // The interrupted turn's stream ended. Its reply was saved when it was interrupted.
      this.attachLateEditedFiles(conversationId, userMessageId || drain.turnId, editedFiles);
      drain.resolve();
      return;
    }
    const live = this.liveTurnIds.get(conversationId);
    if (userMessageId && (this.settledTurnIds.has(userMessageId) || (live !== undefined && live !== userMessageId))) {
      // A late done of a turn the renderer already ended: it must not settle the current turn.
      this.attachLateEditedFiles(conversationId, userMessageId, editedFiles);
      return;
    }
    if (userMessageId) {
      this.settledTurnIds.add(userMessageId);
    }
    this.liveTurnIds.delete(conversationId);
    const generation = this.generationRate.finishTurn(conversationId);
    const isActive = conversationId === this.activeConversationId();
    const { parts, planner, finalText } = this.takeLiveTurnState(conversationId);
    this.removePending(conversationId);

    if (planner?.phase === 'complete') {
      this.hooks.onPlannerComplete?.(conversationId);
    }
    const endedEarly: TurnEndedEarly | undefined =
      outcome === 'completed' ? undefined : outcome === 'aborted' ? 'stopped' : 'error';
    const turn = this.persistTurn(conversationId, parts, finalText, {
      planner: planner ?? undefined,
      editedFiles,
      generation,
      endedEarly,
    });
    if (isActive && !endedEarly && turn) {
      const speech = this.hooks.getSpeechSettings();
      if (speech.enabled) {
        const streamedPrimary = primaryAssistantTextFromParts(parts);
        const ttsText = pickTtsFlushText(streamedPrimary, turn.text);
        if (ttsText.trim()) {
          void this.tts.flushStreamingAssistantText(ttsText, speech.voice, speech.speed);
        }
      }
    }
    this.onConversationTurnEnded(conversationId, outcome);
  }

  /**
   * End `conversationId`'s live turn in the renderer (it will not wait for the stream's done):
   * save its partial reply as `endedEarly`, or drop it when `endedEarly` is null.
   */
  private endLiveTurnLocally(conversationId: string, endedEarly: TurnEndedEarly | null): void {
    const turnId = this.liveTurnIds.get(conversationId) ?? '';
    if (turnId) {
      this.settledTurnIds.add(turnId);
    }
    this.liveTurnIds.delete(conversationId);
    const generation = this.generationRate.finishTurn(conversationId);
    const { parts, planner, finalText } = this.takeLiveTurnState(conversationId);
    this.removePending(conversationId);
    if (endedEarly) {
      this.persistTurn(conversationId, parts, finalText, { planner: planner ?? undefined, generation, endedEarly });
    }
    this.onConversationTurnEnded(conversationId, 'aborted');
  }

  /** Read and clear the in-flight turn state of `conversationId` (active signals or background maps). */
  private takeLiveTurnState(conversationId: string): {
    parts: StreamPart[];
    planner: PlannerProgress | null;
    finalText: string | undefined;
  } {
    const active = conversationId === this.activeConversationId();
    const parts = active ? this.streamingParts() : (this.backgroundStreamParts.get(conversationId) ?? []);
    const planner = active ? this.streamingPlanner() : (this.backgroundStreamPlanner.get(conversationId) ?? null);
    const finalText = this.pendingFinalText.get(conversationId);
    this.pendingFinalText.delete(conversationId);
    this.backgroundStreamPlanner.delete(conversationId);
    if (active) {
      this.toolRunIds.set(new Set());
      this.streamingParts.set([]);
      this.streamingPlanner.set(null);
      this.streamingFinalText.set(undefined);
    } else {
      this.clearBackgroundStream(conversationId);
    }
    return { parts, planner, finalText };
  }

  /**
   * Save a turn's reply into its conversation (in memory when it is open, else on disk). An
   * `endedEarly` turn keeps its partial progress with nothing left looking in flight.
   */
  private persistTurn(
    conversationId: string,
    parts: StreamPart[],
    finalText: string | undefined,
    extras: AssistantTurnExtras,
  ): AssistantTurnPayload | null {
    const endedEarly = extras.endedEarly;
    let turn = buildAssistantTurnFromStreamParts(
      endedEarly ? settleInFlightStreamParts(parts) : parts,
      finalText,
      { endedEarly },
    );
    if (!turn && endedEarly && this.isSubagentConversation(conversationId)) {
      // Stopped before it streamed anything: a read-only sub-agent conversation still says why it
      // has no reply (the user's own empty turns are left out; they know they stopped them).
      turn = { text: '' };
    }
    if (!turn && !endedEarly) {
      return null;
    }
    const titled = !endedEarly && !this.isSubagentConversation(conversationId);
    if (conversationId === this.activeConversationId()) {
      let next = endedEarly ? settleLiveTurnMessages(this.messages()) : this.messages();
      if (turn) {
        next = [...next, assistantMessageFromTurn(turn, extras)];
      }
      this.messages.set(next);
      if (this.activeConversation) {
        this.activeConversation.messages = [...next];
        this.pendingSave = true;
      }
      if (titled) {
        void this.persistActiveAssistantTurnThenMaybeAutoTitle(conversationId).catch((err) =>
          console.error('[ConversationSession] persist assistant / auto-title failed', err),
        );
      } else {
        this.autoSave();
      }
      return turn;
    }
    void this.mutateConversationOnDisk(conversationId, (conv) => {
      if (endedEarly) {
        conv.messages = settleLiveTurnMessages(conv.messages);
      }
      if (turn) {
        conv.messages.push(assistantMessageFromTurn(turn, extras));
      }
    })
      .then(() => (titled ? this.applyMaybeAutoTitleFromMain(conversationId) : undefined))
      .catch((err) => console.error('[ConversationSession] background save / auto-title failed', err));
    return turn;
  }

  /** Files a turn the renderer already ended turned out to have edited (they arrive with its done). */
  private attachLateEditedFiles(
    conversationId: string,
    userMessageId: string,
    files: readonly TurnEditedFile[] | undefined,
  ): void {
    if (!userMessageId || !files?.length) {
      return;
    }
    if (conversationId === this.activeConversationId()) {
      const next = attachTurnEditedFiles(this.messages(), userMessageId, files);
      if (next !== this.messages()) {
        this.messages.set(next);
        this.markMessagesDirtyAndAutoSave();
      }
      return;
    }
    void this.mutateConversationOnDisk(conversationId, (conv) => {
      conv.messages = attachTurnEditedFiles(conv.messages, userMessageId, files);
    });
  }

  /** Sub-agent bookkeeping after any conversation's turn ended (`turnId` is that turn's user message id). */
  /**
   * Sub-agent bookkeeping after any conversation's turn ended. A sub-agent's card turns Done /
   * Stopped / Failed when its own turn ends; finished cards leave the dock when a turn of their
   * parent ends (the one that took in their reports). Running sub-agents outlive parent turns.
   */
  private onConversationTurnEnded(conversationId: string, outcome: SubagentOutcome): void {
    const run = this.subagentRuns().find((r) => r.conversationId === conversationId);
    if (run && run.endedAt === undefined) {
      this.clearSubagentApprovals(conversationId);
      this.cancelParentApprovalsFor(run.parentConversationId, conversationId);
      this.subagentRuns.update((runs) =>
        runs.map((r) => (r.conversationId === conversationId ? { ...r, endedAt: Date.now(), outcome } : r)),
      );
    }
    if (this.subagentRuns().some((r) => r.parentConversationId === conversationId && r.endedAt !== undefined)) {
      this.subagentRuns.update((runs) =>
        runs.filter((r) => r.parentConversationId !== conversationId || r.endedAt === undefined),
      );
    }
  }

  /** Stop every running sub-agent of `parentConversationId` (the dock's Stop all). */
  stopAllSubagents(parentConversationId: string): void {
    for (const run of this.subagentRunsFor(parentConversationId)) {
      if (run.endedAt === undefined) {
        this.stopSubagent(run.conversationId);
      }
    }
  }

  /** A sub-agent ended: nobody waits for the approval cards it raised in its parent's dock. */
  private cancelParentApprovalsFor(parentConversationId: string, subagentConversationId: string): void {
    if (parentConversationId === this.activeConversationId()) {
      const next = cancelSubagentApprovals(this.messages(), subagentConversationId);
      if (next !== this.messages()) {
        this.messages.set(next);
        this.markMessagesDirtyAndAutoSave();
      }
      return;
    }
    void this.mutateConversationOnDisk(parentConversationId, (conv) => {
      conv.messages = cancelSubagentApprovals(conv.messages, subagentConversationId);
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
      // Open a conversation the user can type in, never a (read-only) sub-agent's.
      const conv = (match && !match.parentConversationId ? match : undefined) ?? firstTopLevelConversation(list);
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
      this.activeParentConversationId.set(null);
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
    // A background write still queued for this conversation (a reply, an approval card) lands first.
    const queuedWrite = this.backgroundConversationSaveChains.get(id);
    if (queuedWrite) {
      await queuedWrite;
    }
    const isSubagent = !!this.conversations().find((c) => c.id === id)?.parentConversationId;
    const rejoined = isSubagent ? null : await this.rejoinLiveTurn(id);
    const skipPython =
      isSubagent ||
      (loadOpts?.skipPythonResync !== undefined ? loadOpts.skipPythonResync : this.pendingIds().has(id));
    const conv = await this.electron.loadConversation(id, workspaceId, { skipPythonResync: skipPython });
    if (this.pendingSave && this.activeConversation) {
      // Edits the open conversation got while the load was in flight belong to it, not the next one.
      await this.saveCurrentConversation();
    }
    this.snapshotActiveStreamToBackground();
    this.activeConversation = conv;
    this.activeConversationId.set(conv.id);
    this.activeParentConversationId.set(conv.parentConversationId ?? null);
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
      const abandoned = abandonStaleHitlMessages(conv.messages, (m) => this.isRunningSubagentCard(m));
      if (abandoned !== conv.messages) {
        this.messages.set(abandoned);
        if (this.activeConversation) {
          this.activeConversation.messages = [...abandoned];
          this.pendingSave = true;
        }
        this.autoSave();
      }
    }
    if (rejoined) {
      // Cards the transcript did not save before the reload; saved ones stayed pending above.
      const shown = new Set(conv.messages.map((m) => (m as { payload?: { requestId?: string } }).payload?.requestId));
      for (const card of rejoined.waitingCards) {
        const requestId = (card.payload as { requestId?: string } | null)?.requestId;
        if (requestId && !shown.has(requestId)) {
          this.electron.replayWaitingCard(conv.id, card);
        }
      }
    }
    // After transcript + stream signals match this conversation, so load hooks do not
    // observe the previous chat's messages under the new id.
    this.hooks.onConversationLoaded?.(conv.id, conv.contextTokens);

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
    generation?: TurnGenerationStats,
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
      if (generation) assistant.generation = generation;
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
    const next = attachTurnEditedFiles(this.messages(), userMessageId, files);
    if (next === this.messages()) {
      return;
    }
    this.messages.set(next);
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
    this.generationRate.startTurn(conversationId);
    this.toolRunIds.set(new Set());
    this.streamingParts.set([]);
    this.streamingPlanner.set(null);
    this.streamingFinalText.set(undefined);
  }

  /**
   * Start-of-turn bookkeeping for a turn the app starts on its own, to hand the main agent the
   * reports of sub-agents that finished while no turn was running. Writes the turn's marker
   * message (in memory when the conversation is open, else on disk first) and marks it live.
   * Returns null when the conversation is busy or gone (a live turn picks the reports up itself).
   */
  async beginSubagentResultsTurn(
    conversationId: string,
    names: readonly string[],
  ): Promise<{ userMessageId: string; text: string; workspaceId: string | null } | null> {
    if (this.pendingIds().has(conversationId) || this.deletedConversationIds.has(conversationId)) {
      return null;
    }
    const userMessageId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message: ChatMessage = {
      role: 'user',
      id: userMessageId,
      text: names.length ? `Results from sub-agents: ${names.join(', ')}` : 'Results from sub-agents',
      subagentResults: [...names],
    };
    let workspaceId: string | null;
    if (conversationId === this.activeConversationId()) {
      this.prepareForSend(conversationId);
      this.messages.update((prev) => [...prev, message]);
      this.markMessagesDirtyAndAutoSave();
      workspaceId = this.activeConversation?.workspaceId ?? this.hooks.getCurrentWorkspaceId();
    } else {
      this.addPending(conversationId);
      this.generationRate.startTurn(conversationId);
      this.clearBackgroundStream(conversationId);
      // On disk before the turn's reply, which is saved on the same per-conversation chain.
      await this.mutateConversationOnDisk(conversationId, (conv) => {
        conv.messages.push(message);
      });
      workspaceId =
        this.conversations().find((c) => c.id === conversationId)?.workspaceId ?? this.hooks.getCurrentWorkspaceId();
    }
    this.beginLiveTurn(conversationId, userMessageId);
    return { userMessageId, text: message.text, workspaceId };
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

  /** The chat server went away: keep what the turn produced (as failed) instead of waiting for done. */
  private settleInFlightAsAborted(conversationId: string): void {
    this.endLiveTurnLocally(conversationId, 'error');
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

  /**
   * Read-modify-write a conversation that is not open, chained per conversation so concurrent
   * writes (a background turn's reply, its approval cards, a sub-agent cancelling one) never
   * overwrite each other. Deleted conversations are skipped.
   */
  private mutateConversationOnDisk(conversationId: string, mutate: (conv: Conversation) => void): Promise<void> {
    const prev = this.backgroundConversationSaveChains.get(conversationId) ?? Promise.resolve();
    const mine = prev.then(async () => {
      if (this.deletedConversationIds.has(conversationId)) {
        return;
      }
      try {
        const convMeta = this.conversations().find((c) => c.id === conversationId);
        const workspaceId = convMeta?.workspaceId ?? this.hooks.getCurrentWorkspaceId();
        const conv = await this.electron.readConversationFromDisk(conversationId, workspaceId);
        mutate(conv);
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

  private persistArtifactToConversation(conversationId: string, message: ChatMessage): Promise<void> {
    return this.mutateConversationOnDisk(conversationId, (conv) => {
      conv.messages.push(message);
    });
  }

  private bumpConversation(id: string): void {
    this.updateConversationMeta(id, { updatedAt: new Date().toISOString() });
  }

  private async rememberLastActiveForWorkspace(conv: Conversation): Promise<void> {
    const key = conv.workspaceId ?? '';
    // Startup reopens a conversation the user can type in, so a sub-agent's stands for its parent.
    await this.electron.setLastActiveConversation(key, conv.parentConversationId || conv.id);
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
    this.streamingParts.update((prev) => mergeHitlTrailIntoLiveStreamParts(prev, artifacts));
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
      mergeHitlTrailIntoLiveStreamParts(prev, [artifact]),
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

  private syncChainTextFromReadToolTrail(parts: StreamPart[], chunkStatusId?: string): void {
    const idx = findReadToolTrailTargetIndex(parts, chunkStatusId);
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
