import type { FileDiffPayload } from './diff';
import type { AcceptCommandPayload } from './accept-command';
import type { AgentQuestionPayload } from './agent-question';
import type { ThemeProposalPayload } from './theme-proposal';
import type { CopyConfirmPayload } from './copy-confirm';
import type { DeleteConfirmPayload } from './delete-confirm';
import type { PlanConfirmPayload } from './plan-confirm';
import type {
  StagedTransferBatchPayload,
  StagedTransferFileResolution,
} from './staged-transfer-batch';
import type { LlmAgentRole, PlannerProgress } from './llm';
import type { TurnEditedFile } from './turn-edits';

/** One OpenAI-style multimodal block for POST /chat/stream (`structuredContent` / `structured_content`). */
export type ChatStructuredContentPart = Readonly<Record<string, unknown>>;

/** One labeled segment of an in-flight assistant reply (multiplexed LLM subgraphs share one bubble). */
export interface StreamPart {
  streamTag: string;
  label: string;
  text: string;
  /** Set when the backend emits `tool_exec_complete` for this multiplexed subprocess stream. */
  runComplete?: boolean;
  /** Subprocess exit code when `runComplete`; null if finished but code unknown. */
  exitCode?: number | null;
  /** Smoke-test verdict when backend intentionally stopped a watch process. */
  outcome?: 'passed' | 'failed';
  /** Present on synthetic `tool-trail:*` segments: mirrors IPC tool status in the auxiliary timeline. */
  toolChainState?: 'running' | 'complete' | 'error';
  /** Tool-trail rows: LLM step id from the backend; the live preview never batches across steps. */
  toolBatch?: string;
  /**
   * Tool-trail rows: path / query / command the call ran against, kept from the first running
   * status (the completed status replaces `text` with the result).
   */
  toolTarget?: string;
  /** Tool-trail rows of finished edits: unified diff of what the call wrote, shown when expanded. */
  toolDiff?: string;
  /** Tool-trail rows of finished calls: how long the call ran, in milliseconds. */
  toolDurationMs?: number;
  /** Tool-trail rows of `spawn_subagent`: the sub-agent conversation the call ran (Open link). */
  toolSubagentId?: string;
  /** Tool-trail rows of `spawn_subagent`: the sub-agent's label. */
  toolSubagentName?: string;
  /** Tool-trail rows still running when their turn was stopped or interrupted. */
  toolStopped?: true;
  /** Reasoning segments: epoch ms when the first chunk arrived (drives the live `Thinking · 7s` pill). */
  thoughtStartedAt?: number;
  /** Reasoning segments: how long the model thought, set when the next segment begins. */
  thoughtDurationMs?: number;
}

/** Why an assistant turn ended before the agent finished it. */
export type TurnEndedEarly = 'stopped' | 'interrupted' | 'error';

/** How fast the model produced one assistant turn, summed over the turn's model calls. */
export interface TurnGenerationStats {
  outputTokens: number;
  /** Decode time only (first streamed token -> model end), so prefill and tool runs are excluded. */
  generationMs: number;
  /** Wall-clock time of the whole turn (send -> done), including prefill, tool runs and every model call. */
  turnMs?: number;
  /** Counted from streamed text because the provider reported no usage for this turn. */
  estimated?: boolean;
}

/** Tokens per second for {@link TurnGenerationStats}; 0 when no decode time was measured. */
export function turnTokensPerSecond(stats: TurnGenerationStats): number {
  return stats.generationMs > 0 ? (stats.outputTokens * 1000) / stats.generationMs : 0;
}

/** `8.4` / `42.3` / `118` — one decimal below 100 tok/s, whole numbers above. */
export function formatTokensPerSecond(tokensPerSecond: number): string {
  return tokensPerSecond >= 100 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

/** Lifecycle of a proposed edit card in the chat transcript. */
export type DiffReviewStatus = 'pending' | 'complete' | 'cancelled';

/** List row / sidebar metadata for a conversation. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceId: string | null;
  /** When true, the user renamed the title; the app will not overwrite it with model-generated titles. */
  customTitle: boolean;
  /** Set on sub-agent conversations: the conversation whose agent spawned this one. */
  parentConversationId?: string | null;
  /** Set on sub-agent conversations: the parent user message whose turn spawned this one. */
  parentTurnId?: string | null;
}

/** One message in the chat UI (user/assistant text or tool chain row). */
export type ConversationMessage =
  | {
      role: 'user';
      text: string;
      /** Stable restore-point id (assigned when the user sends). Optional on older transcripts. */
      id?: string;
      structuredContent?: readonly ChatStructuredContentPart[];
      /** Sub-agent conversations: the task the main agent sent, not something the user typed. */
      fromAgent?: true;
      /**
       * Set on a turn the app started on its own to hand the main agent the reports of sub-agents
       * that finished while no turn was running: their names (the reports themselves go to the model).
       */
      subagentResults?: string[];
    }
  | {
      role: 'assistant';
      text: string;
      planner?: PlannerProgress;
      toolStreams?: StreamPart[];
      /** Auxiliary model output (reasoning channel); streamTag matches the SSE auxiliary tag. */
      reasoningStreams?: StreamPart[];
      /** Legacy on-disk field from pre-rename builds. */
      moeStreams?: StreamPart[];
      /** Multiplex order for reasoning + delegated streams (non-primary tags), when available. */
      auxiliaryStreamTimeline?: StreamPart[];
      /** Files the agent wrote during this turn (end-of-turn review footer). */
      editedFiles?: TurnEditedFile[];
      /** Output speed of this turn (tok/s readout under the reply and in the composer). */
      generation?: TurnGenerationStats;
      /** Set when the turn was stopped, interrupted by a new message, or failed: the reply is partial. */
      endedEarly?: TurnEndedEarly;
    }
  | {
      role: 'chain';
      label: string;
      text: string;
      state: 'running' | 'complete' | 'error';
      source: 'agent' | 'tool';
      statusId: string;
      agentRole?: LlmAgentRole;
      streamTag?: string;
    }
  // Retired review cards (`diff`, `copy_confirm`, `staged_transfer_batch`): nothing creates them now;
  // they remain so older saved conversations load, render read-only and can still be restored.
  | {
      role: 'diff';
      payload: FileDiffPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'accept_command';
      payload: AcceptCommandPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'copy_confirm';
      payload: CopyConfirmPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'delete_confirm';
      payload: DeleteConfirmPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'plan_confirm';
      payload: PlanConfirmPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'staged_transfer_batch';
      payload: StagedTransferBatchPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
      fileResolutions?: Record<string, StagedTransferFileResolution>;
    }
  | {
      role: 'agent_question';
      payload: AgentQuestionPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    }
  | {
      role: 'theme_proposal';
      payload: ThemeProposalPayload;
      reviewStatus?: DiffReviewStatus;
      reviewSummary?: string;
    };

/** Full conversation as used in the renderer. */
export interface Conversation extends ConversationMeta {
  messages: ConversationMessage[];
  workspaceId: string | null;
  themeId: string;
}

/** On-disk / IPC chat row — same shape as the renderer conversation message. */
export type ConversationFileMessage = ConversationMessage;

/**
 * On-disk JSON shape used by the main process.
 * Loaded/saved via IPC; Python history sync uses user/assistant roles only.
 */
export interface ConversationFile {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationFileMessage[];
  workspaceId: string | null;
  themeId: string;
  /** When true, the user renamed the title; the app will not overwrite it with model-generated titles. */
  customTitle: boolean;
  /** Sub-agent conversations: the spawning conversation (see {@link ConversationMeta}). */
  parentConversationId?: string | null;
  /** Sub-agent conversations: the parent user message whose turn spawned this one. */
  parentTurnId?: string | null;
}

/** Result of IPC `maybe-auto-title-conversation` (model-generated sidebar title). */
export type MaybeAutoTitleResult =
  | { ok: true; title: string; updatedAt: string }
  | {
      ok: false;
      reason: 'not_found' | 'locked' | 'not_due' | 'python_error' | 'empty_title' | 'fetch_failed';
    };

/** Minimal fields for “recent conversations” menu aggregation. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}
