import type { AcceptCommandPayload } from './types/accept-command';
import type { CopyConfirmPayload } from './types/copy-confirm';
import type { DeleteConfirmPayload } from './types/delete-confirm';
import type { FileDiffPayload } from './types/diff';
import type { LlmStatusPayload } from './types/llm';

export type ParsedAgentStreamPayload =
  | { type: 'chunk'; delta: string; streamTag?: string }
  | { type: 'tool_read_chunk'; delta: string }
  | { type: 'tool_exec_chunk'; delta: string; streamTag?: string; label?: string }
  | {
      type: 'tool_exec_complete';
      streamTag?: string;
      label?: string;
      exitCode?: number | null;
      /** Full or tail replay when live chunks were empty or incomplete (pytest/smoke). */
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
    }
  | { type: 'status'; status: LlmStatusPayload }
  | { type: 'diff'; diff: FileDiffPayload }
  | { type: 'accept_command'; acceptCommand: AcceptCommandPayload }
  | { type: 'copy_confirm'; copyConfirm: CopyConfirmPayload }
  | { type: 'delete_confirm'; deleteConfirm: DeleteConfirmPayload }
  | { type: 'harness_crystal'; polarity: 'positive' | 'negative' }
  | { type: 'final_text'; text: string };

type RawAgentStreamPayload = {
  type?: string;
  delta?: string;
  stream_tag?: string;
  label?: string;
  exit_code?: unknown;
  output_excerpt?: unknown;
  outcome?: unknown;
  polarity?: string;
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  status?: LlmStatusPayload & { agent_role?: string; stream_tag?: string };
  diff?: unknown;
  acceptCommand?: unknown;
  copyConfirm?: unknown;
  deleteConfirm?: unknown;
};

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseAgentStreamPayload(payload: string): ParsedAgentStreamPayload {
  try {
    const parsed = JSON.parse(payload) as RawAgentStreamPayload;
    if (parsed.type === 'status' && parsed.status) {
      const rawRole = parsed.status.agent_role;
      const agentRole = rawRole === 'manager' || rawRole === 'worker' ? rawRole : undefined;
      return {
        type: 'status',
        status: {
          id: parsed.status.id,
          label: parsed.status.label,
          detail: parsed.status.detail ?? '',
          state: parsed.status.state ?? 'running',
          source: parsed.status.source ?? 'agent',
          ...(optionalTrimmedString(parsed.status.stream_tag)
            ? { streamTag: optionalTrimmedString(parsed.status.stream_tag) }
            : {}),
          ...(agentRole ? { agentRole } : {}),
        },
      };
    }

    if (parsed.type === 'diff' && parsed.diff && typeof parsed.diff === 'object') {
      return { type: 'diff', diff: parsed.diff as FileDiffPayload };
    }

    if (parsed.type === 'accept_command' && parsed.acceptCommand && typeof parsed.acceptCommand === 'object') {
      return {
        type: 'accept_command',
        acceptCommand: parsed.acceptCommand as AcceptCommandPayload,
      };
    }

    if (parsed.type === 'copy_confirm' && parsed.copyConfirm && typeof parsed.copyConfirm === 'object') {
      return {
        type: 'copy_confirm',
        copyConfirm: parsed.copyConfirm as CopyConfirmPayload,
      };
    }

    if (parsed.type === 'delete_confirm' && parsed.deleteConfirm && typeof parsed.deleteConfirm === 'object') {
      return {
        type: 'delete_confirm',
        deleteConfirm: parsed.deleteConfirm as DeleteConfirmPayload,
      };
    }

    if (parsed.type === 'tool_read_chunk' && typeof parsed.delta === 'string') {
      return { type: 'tool_read_chunk', delta: parsed.delta };
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
      const inputRaw = parsed.input_tokens;
      if (typeof inputRaw === 'number' && Number.isFinite(inputRaw) && inputRaw >= 0) {
        const out: {
          type: 'token_usage';
          inputTokens: number;
          outputTokens?: number;
          totalTokens?: number;
        } = { type: 'token_usage', inputTokens: Math.floor(inputRaw) };
        const oraw = parsed.output_tokens;
        const traw = parsed.total_tokens;
        if (typeof oraw === 'number' && Number.isFinite(oraw) && oraw >= 0) {
          out.outputTokens = Math.floor(oraw);
        }
        if (typeof traw === 'number' && Number.isFinite(traw) && traw >= 0) {
          out.totalTokens = Math.floor(traw);
        }
        return out;
      }
    }

    if (parsed.type === 'harness_crystal') {
      const pol = parsed.polarity;
      if (pol === 'positive' || pol === 'negative') {
        return { type: 'harness_crystal', polarity: pol };
      }
    }

    if (parsed.type === 'final_text') {
      const text = (parsed as { text?: string }).text;
      if (typeof text === 'string') {
        return { type: 'final_text', text };
      }
    }
  } catch {
    // Fall through to plain text chunks.
  }

  return { type: 'chunk', delta: payload };
}
