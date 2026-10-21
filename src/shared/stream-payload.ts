/**
 * Canonical parser for the agent SSE/stream wire protocol.
 *
 * The backend emits one JSON object per event line. `parseAgentStreamPayload`
 * turns each line into a typed `ParsedAgentStreamPayload` variant the UI can
 * switch on. See `./stream-payload.md` for the full wire-protocol reference.
 *
 * Contract: this module never throws. Any parse/validation failure degrades
 * to a `{ type: 'chunk', delta: payload }` text chunk so a malformed line can
 * never kill the stream loop.
 */
import type { BuildPlanChunkPayload, BuildPlanOpenPayload, BuildPlanStreamEndPayload } from './types/build-plan';
import type { AcceptCommandPayload } from './types/accept-command';
import type { AgentQuestionPayload } from './types/agent-question';
import type { DeleteConfirmPayload } from './types/delete-confirm';
import type { LlmStatusPayload, PlannerProgress } from './types/llm';
import type { PlanConfirmPayload } from './types/plan-confirm';
import { normalizePlanConfirmFilesToChange } from './types/plan-confirm';
import type { ThemeProposalPayload } from './types/theme-proposal';
import { isThemeProposalPayload } from './types/theme-proposal';
import type { AppendConversationFileJournalRequest } from './types/conversation-timeline';
import type { SubagentOutcome, SubagentRef } from './types/subagent';
import { parseFileJournalSsePayload } from './conversation-timeline';

/**
 * Discriminated union (discriminant: `type`) of every event the agent stream
 * can produce. Consumers should `switch (payload.type)` and let TypeScript
 * narrow the variant. Field names are normalized to camelCase regardless of
 * the snake_case wire form.
 */
export type ParsedAgentStreamPayload =
  | { type: 'chunk'; delta: string; streamTag?: string }
  | { type: 'tool_read_chunk'; delta: string; statusId?: string }
  | { type: 'tool_exec_chunk'; delta: string; streamTag?: string; label?: string }
  | {
      type: 'background_command_open';
      commandId: string;
      commandText: string;
      cwdLabel: string;
      label: string;
      streamTag: string;
    }
  | {
      type: 'tool_exec_complete';
      streamTag?: string;
      label?: string;
      exitCode?: number | null;
      /** Full or tail replay when live chunks were empty or incomplete (pytest/overlay). */
      outputExcerpt?: string;
      /** When set, drives the terminal badge instead of raw exit code (watch-mode smoke tests). */
      outcome?: 'passed' | 'failed';
    }
  | {
      type: 'token_usage';
      /** Prompt tokens for the completed request (OpenAI ``prompt_tokens`` / LangChain ``input_tokens``). */
      inputTokens: number;
      outputTokens?: number;
      totalTokens?: number;
      /** Decode time for this request (first streamed token -> model end), when the backend timed it. */
      generationMs?: number;
    }
  | { type: 'status'; status: LlmStatusPayload }
  | { type: 'accept_command'; acceptCommand: AcceptCommandPayload }
  | { type: 'delete_confirm'; deleteConfirm: DeleteConfirmPayload }
  | { type: 'planner_progress'; planner: PlannerProgress }
  | { type: 'build_plan_open'; buildPlanOpen: BuildPlanOpenPayload }
  | { type: 'build_plan_chunk'; buildPlanChunk: BuildPlanChunkPayload }
  | { type: 'build_plan_stream_end'; buildPlanStreamEnd: BuildPlanStreamEndPayload }
  | { type: 'plan_confirm'; planConfirm: PlanConfirmPayload }
  | { type: 'agent_question'; agentQuestion: AgentQuestionPayload }
  | { type: 'theme_proposal'; themeProposal: ThemeProposalPayload }
  | {
      type: 'file_journal';
      fileJournal: Omit<AppendConversationFileJournalRequest, 'conversationId'>;
    }
  | { type: 'final_text'; text: string }
  | { type: 'clear_primary_stream' }
  | { type: 'promote_primary_to_nudge' }
  | {
      type: 'context_compressed';
      tokensBefore: number;
      tokensAfter: number;
      toolMessagesCompacted: number;
      toolRoundsDropped: number;
    }
  | {
      type: 'subagent_started';
      /** The sub-agent's conversation id (also its Python session id). */
      conversationId: string;
      /** The conversation whose agent spawned it. */
      parentConversationId?: string;
      /** The parent user message whose turn spawned it (its edits are journaled under that turn). */
      parentTurnId?: string;
      name: string;
      task: string;
      /** Status id of the parent's `spawn_subagent` pill. */
      statusId?: string;
      /** Started with `background: true`: the parent agent did not wait for its report. */
      background?: boolean;
    }
  | {
      type: 'subagent_event';
      conversationId: string;
      /** One event of the sub-agent's own stream; `null` when it was invalid or itself a `subagent_*` event. */
      payload: ParsedAgentStreamPayload | null;
    }
  | { type: 'subagent_finished'; conversationId: string; outcome: SubagentOutcome }
  | {
      /** Reports of sub-agents wait for a parent with no turn running: start one to hand them over. */
      type: 'subagent_results_ready';
      parentConversationId: string;
      names: string[];
    };

/**
 * Internal `typeof JSON.parse(...)` cast. Everything is `unknown` (except
 * `type` and a few nested objects) so each dispatch branch is forced to
 * validate before narrowing. Mirrors the snake_case wire schema; not exported.
 */
type RawAgentStreamPayload = {
  type?: string;
  delta?: string;
  /** `tool_read_chunk`: the tool status row the read body belongs to. */
  status_id?: string;
  stream_tag?: string;
  label?: string;
  exit_code?: unknown;
  output_excerpt?: unknown;
  outcome?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  generation_ms?: unknown;
  tokens_before?: unknown;
  tokens_after?: unknown;
  tool_messages_compacted?: unknown;
  tool_rounds_dropped?: unknown;
  tokensBefore?: unknown;
  tokensAfter?: unknown;
  toolMessagesCompacted?: unknown;
  toolRoundsDropped?: unknown;
  status?: LlmStatusPayload & {
    agent_role?: string;
    stream_tag?: string;
    tool_batch?: string;
    diff?: unknown;
    duration_ms?: unknown;
    subagent?: unknown;
  };
  acceptCommand?: unknown;
  command_id?: unknown;
  command_text?: unknown;
  cwd_label?: unknown;
  deleteConfirm?: unknown;
  planner?: unknown;
  planConfirm?: unknown;
  agentQuestion?: unknown;
  themeProposal?: unknown;
  buildPlanOpen?: unknown;
  buildPlanChunk?: unknown;
  buildPlanStreamEnd?: unknown;
  fileJournal?: unknown;
  /** `subagent_*`: the sub-agent's conversation id. */
  conversation_id?: unknown;
  parent_conversation_id?: unknown;
  parent_turn_id?: unknown;
  name?: unknown;
  task?: unknown;
  background?: unknown;
  names?: unknown;
  /** `subagent_event`: the wrapped event of the sub-agent's stream. */
  payload?: unknown;
};

const SUBAGENT_OUTCOMES: ReadonlySet<string> = new Set(['completed', 'aborted', 'error']);

/** `{conversation_id, name}` from the wire, or `undefined` when the id is missing. */
function optionalSubagentRef(value: unknown): SubagentRef | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as { conversation_id?: unknown; name?: unknown };
  const conversationId = optionalTrimmedString(raw.conversation_id);
  if (!conversationId) {
    return undefined;
  }
  return { conversationId, name: optionalTrimmedString(raw.name) ?? 'Sub-agent' };
}

function isSubagentPayload(payload: ParsedAgentStreamPayload): boolean {
  return (
    payload.type === 'subagent_started' ||
    payload.type === 'subagent_event' ||
    payload.type === 'subagent_finished' ||
    payload.type === 'subagent_results_ready'
  );
}

/** Returns the trimmed string if non-empty after trimming, else `undefined`. Empty/whitespace values are dropped so consumers can rely on truthy checks. */
function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Returns `Math.floor(value)` when it is a finite, non-negative number, else `undefined`. Used for token counts and compaction counters. */
function optionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Parse one JSON event line into a typed `ParsedAgentStreamPayload`.
 *
 * If no branch of {@link parseAgentStreamValue} matches, or `JSON.parse`
 * throws, the raw payload is returned as a plain-text `chunk` — see the module
 * contract above.
 */
export function parseAgentStreamPayload(payload: string): ParsedAgentStreamPayload {
  try {
    const parsed = parseAgentStreamValue(JSON.parse(payload));
    if (parsed) {
      return parsed;
    }
  } catch {
    // Fall through to plain text chunks — see the module contract: never throw on bad input.
  }

  // Last-resort fallback: treat the raw payload as assistant text so a malformed line renders instead of crashing the stream.
  return { type: 'chunk', delta: payload };
}

/**
 * Parse one already-decoded event object, or `null` when it matches no event.
 *
 * Branches are checked most-specific-first (e.g. `tool_exec_chunk` before the
 * generic `chunk`) so specific events are not shadowed. Each branch validates
 * the minimum required fields; on failure it falls through to the next branch.
 * Unlike {@link parseAgentStreamPayload} there is no text fallback, so a
 * sub-agent's wrapped event that does not parse is dropped, not shown as text.
 */
export function parseAgentStreamValue(value: unknown): ParsedAgentStreamPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  try {
    const parsed = value as RawAgentStreamPayload;
    if (parsed.type === 'status' && parsed.status) {
      // Only 'manager'/'worker' are valid agent roles; anything else is dropped to avoid surfacing stale/unknown enum values.
      const rawRole = parsed.status.agent_role;
      const agentRole = rawRole === 'manager' || rawRole === 'worker' ? rawRole : undefined;
      return {
        type: 'status',
        status: {
          // Defaults keep old saved conversations renderable when the backend omitted these fields.
          id: parsed.status.id,
          label: parsed.status.label,
          detail: parsed.status.detail ?? '',
          state: parsed.status.state ?? 'running',
          source: parsed.status.source ?? 'agent',
          ...(optionalTrimmedString(parsed.status.stream_tag)
            ? { streamTag: optionalTrimmedString(parsed.status.stream_tag) }
            : {}),
          ...(agentRole ? { agentRole } : {}),
          ...(optionalTrimmedString(parsed.status.tool_batch)
            ? { toolBatch: optionalTrimmedString(parsed.status.tool_batch) }
            : {}),
          ...(typeof parsed.status.diff === 'string' && parsed.status.diff ? { toolDiff: parsed.status.diff } : {}),
          ...(typeof parsed.status.duration_ms === 'number' &&
          Number.isFinite(parsed.status.duration_ms) &&
          parsed.status.duration_ms >= 0
            ? { durationMs: parsed.status.duration_ms }
            : {}),
          ...(optionalSubagentRef(parsed.status.subagent)
            ? { subagent: optionalSubagentRef(parsed.status.subagent) }
            : {}),
        },
      };
    }

    if (parsed.type === 'subagent_started') {
      const conversationId = optionalTrimmedString(parsed.conversation_id);
      if (conversationId) {
        const parentConversationId = optionalTrimmedString(parsed.parent_conversation_id);
        const parentTurnId = optionalTrimmedString(parsed.parent_turn_id);
        const statusId = optionalTrimmedString(parsed.status_id);
        return {
          type: 'subagent_started',
          conversationId,
          name: optionalTrimmedString(parsed.name) ?? 'Sub-agent',
          task: typeof parsed.task === 'string' ? parsed.task : '',
          ...(parentConversationId ? { parentConversationId } : {}),
          ...(parentTurnId ? { parentTurnId } : {}),
          ...(statusId ? { statusId } : {}),
          ...(parsed.background === true ? { background: true } : {}),
        };
      }
    }

    if (parsed.type === 'subagent_results_ready') {
      const parentConversationId = optionalTrimmedString(parsed.parent_conversation_id);
      if (parentConversationId) {
        const names = Array.isArray(parsed.names)
          ? parsed.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim())
          : [];
        return { type: 'subagent_results_ready', parentConversationId, names };
      }
    }

    if (parsed.type === 'subagent_event') {
      const conversationId = optionalTrimmedString(parsed.conversation_id);
      if (conversationId) {
        const inner = parseAgentStreamValue(parsed.payload);
        // Sub-agents cannot spawn, so a nested `subagent_*` event is never forwarded.
        return { type: 'subagent_event', conversationId, payload: inner && !isSubagentPayload(inner) ? inner : null };
      }
    }

    if (parsed.type === 'subagent_finished') {
      const conversationId = optionalTrimmedString(parsed.conversation_id);
      if (conversationId) {
        const outcome =
          typeof parsed.outcome === 'string' && SUBAGENT_OUTCOMES.has(parsed.outcome)
            ? (parsed.outcome as SubagentOutcome)
            : 'error';
        return { type: 'subagent_finished', conversationId, outcome };
      }
    }

    if (parsed.type === 'accept_command' && parsed.acceptCommand && typeof parsed.acceptCommand === 'object') {
      return {
        type: 'accept_command',
        acceptCommand: parsed.acceptCommand as AcceptCommandPayload,
      };
    }

    if (parsed.type === 'delete_confirm' && parsed.deleteConfirm && typeof parsed.deleteConfirm === 'object') {
      return {
        type: 'delete_confirm',
        deleteConfirm: parsed.deleteConfirm as DeleteConfirmPayload,
      };
    }

    if (parsed.type === 'planner_progress' && parsed.planner && typeof parsed.planner === 'object') {
      return {
        type: 'planner_progress',
        planner: parsed.planner as PlannerProgress,
      };
    }

    if (parsed.type === 'plan_confirm' && parsed.planConfirm && typeof parsed.planConfirm === 'object') {
      // Normalize legacy `filesToChange` shapes so the renderer always sees a consistent form regardless of which backend version emitted it.
      const rawConfirm = parsed.planConfirm as PlanConfirmPayload & { filesToChange?: unknown };
      return {
        type: 'plan_confirm',
        planConfirm: {
          ...rawConfirm,
          filesToChange: normalizePlanConfirmFilesToChange(rawConfirm.filesToChange),
        },
      };
    }

    if (parsed.type === 'agent_question' && parsed.agentQuestion && typeof parsed.agentQuestion === 'object') {
      return {
        type: 'agent_question',
        agentQuestion: parsed.agentQuestion as AgentQuestionPayload,
      };
    }

    if (parsed.type === 'theme_proposal' && isThemeProposalPayload(parsed.themeProposal)) {
      return {
        type: 'theme_proposal',
        themeProposal: parsed.themeProposal,
      };
    }

    if (parsed.type === 'build_plan_open' && parsed.buildPlanOpen && typeof parsed.buildPlanOpen === 'object') {
      return {
        type: 'build_plan_open',
        buildPlanOpen: parsed.buildPlanOpen as BuildPlanOpenPayload,
      };
    }

    if (parsed.type === 'build_plan_chunk' && parsed.buildPlanChunk && typeof parsed.buildPlanChunk === 'object') {
      // Require both fields to be strings; otherwise fall through to the plain-text chunk fallback rather than emitting a half-formed event.
      const chunk = parsed.buildPlanChunk as { relativePath?: unknown; content?: unknown };
      if (typeof chunk.relativePath === 'string' && typeof chunk.content === 'string') {
        return {
          type: 'build_plan_chunk',
          buildPlanChunk: {
            relativePath: chunk.relativePath,
            content: chunk.content,
          },
        };
      }
    }

    if (
      parsed.type === 'build_plan_stream_end'
      && parsed.buildPlanStreamEnd
      && typeof parsed.buildPlanStreamEnd === 'object'
    ) {
      const end = parsed.buildPlanStreamEnd as { relativePath?: unknown };
      if (typeof end.relativePath === 'string') {
        return {
          type: 'build_plan_stream_end',
          buildPlanStreamEnd: { relativePath: end.relativePath },
        };
      }
    }

    if (parsed.type === 'file_journal') {
      const rawJournal = parsed.fileJournal && typeof parsed.fileJournal === 'object' ? parsed.fileJournal : parsed;
      const fileJournal = parseFileJournalSsePayload(rawJournal);
      if (fileJournal) {
        return { type: 'file_journal', fileJournal };
      }
    }

    if (parsed.type === 'tool_read_chunk' && typeof parsed.delta === 'string') {
      const statusId = optionalTrimmedString(parsed.status_id);
      return { type: 'tool_read_chunk', delta: parsed.delta, ...(statusId ? { statusId } : {}) };
    }

    if (parsed.type === 'background_command_open') {
      // All fields are coerced to strings with safe defaults; `commandId` is required — without it the UI cannot correlate subsequent chunks, so we fall through.
      const commandId = optionalTrimmedString(parsed.command_id);
      const commandText = typeof parsed.command_text === 'string' ? parsed.command_text : '';
      const cwdLabel = typeof parsed.cwd_label === 'string' ? parsed.cwd_label : '';
      const label = optionalTrimmedString(parsed.label) ?? '';
      const streamTag = optionalTrimmedString(parsed.stream_tag) ?? '';
      if (commandId) {
        return {
          type: 'background_command_open',
          commandId,
          commandText,
          cwdLabel,
          label,
          streamTag,
        };
      }
    }

    if (parsed.type === 'tool_exec_chunk' && typeof parsed.delta === 'string') {
      return {
        type: 'tool_exec_chunk',
        delta: parsed.delta,
        streamTag: optionalTrimmedString(parsed.stream_tag),
        label: optionalTrimmedString(parsed.label),
      };
    }

    if (parsed.type === 'tool_exec_complete') {
      // `exit_code` may be absent, a number, or null (process killed without an exit status) — preserve each case distinctly.
      const exitRaw = parsed.exit_code;
      let exitCode: number | null | undefined;
      if (typeof exitRaw === 'number' && Number.isFinite(exitRaw)) {
        exitCode = exitRaw;
      } else if (exitRaw === null) {
        exitCode = null;
      }
      const excerptRaw = parsed.output_excerpt;
      const outputExcerpt =
        typeof excerptRaw === 'string' && excerptRaw.trim() ? excerptRaw.trim() : undefined;
      const outcomeRaw = parsed.outcome;
      const outcome =
        outcomeRaw === 'passed' || outcomeRaw === 'failed' ? outcomeRaw : undefined;
      return {
        type: 'tool_exec_complete',
        streamTag: optionalTrimmedString(parsed.stream_tag),
        label: optionalTrimmedString(parsed.label),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(outputExcerpt ? { outputExcerpt } : {}),
        ...(outcome ? { outcome } : {}),
      };
    }

    if (parsed.type === 'chunk' && typeof parsed.delta === 'string') {
      return {
        type: 'chunk',
        delta: parsed.delta,
        streamTag: optionalTrimmedString(parsed.stream_tag),
      };
    }

    if (parsed.type === 'token_usage') {
      // `input_tokens` is required; without it the event is meaningless, so fall through to the plain-text chunk fallback.
      const inputRaw = parsed.input_tokens;
      if (typeof inputRaw === 'number' && Number.isFinite(inputRaw) && inputRaw >= 0) {
        const out: {
          type: 'token_usage';
          inputTokens: number;
          outputTokens?: number;
          totalTokens?: number;
          generationMs?: number;
        } = { type: 'token_usage', inputTokens: Math.floor(inputRaw) };
        const oraw = parsed.output_tokens;
        const traw = parsed.total_tokens;
        if (typeof oraw === 'number' && Number.isFinite(oraw) && oraw >= 0) {
          out.outputTokens = Math.floor(oraw);
        }
        if (typeof traw === 'number' && Number.isFinite(traw) && traw >= 0) {
          out.totalTokens = Math.floor(traw);
        }
        const graw = parsed.generation_ms;
        if (typeof graw === 'number' && Number.isFinite(graw) && graw > 0) {
          out.generationMs = graw;
        }
        return out;
      }
    }

    if (parsed.type === 'final_text') {
      const text = (parsed as { text?: string }).text;
      if (typeof text === 'string') {
        return { type: 'final_text', text };
      }
    }

    if (parsed.type === 'clear_primary_stream') {
      return { type: 'clear_primary_stream' };
    }

    if (parsed.type === 'promote_primary_to_nudge') {
      return { type: 'promote_primary_to_nudge' };
    }

    if (parsed.type === 'context_compressed') {
      // Accept both camelCase and snake_case forms for backwards compatibility with older saved conversations.
      const tokensBefore =
        optionalNonNegativeInt(parsed.tokensBefore) ?? optionalNonNegativeInt(parsed.tokens_before);
      const tokensAfter =
        optionalNonNegativeInt(parsed.tokensAfter) ?? optionalNonNegativeInt(parsed.tokens_after);
      // These two default to 0 when absent (older emitters did not report them).
      const toolMessagesCompacted =
        optionalNonNegativeInt(parsed.toolMessagesCompacted)
        ?? optionalNonNegativeInt(parsed.tool_messages_compacted)
        ?? 0;
      const toolRoundsDropped =
        optionalNonNegativeInt(parsed.toolRoundsDropped)
        ?? optionalNonNegativeInt(parsed.tool_rounds_dropped)
        ?? 0;
      // Both token counts are required; otherwise the event is unusable, so fall through.
      if (tokensBefore !== undefined && tokensAfter !== undefined) {
        return {
          type: 'context_compressed',
          tokensBefore,
          tokensAfter,
          toolMessagesCompacted,
          toolRoundsDropped,
        };
      }
    }
  } catch {
    // A normalizer choked on a malformed nested object: no event (see the module contract).
  }
  return null;
}
