import type { AcceptCommandPayload } from './types/accept-command';
import type { CopyConfirmPayload } from './types/copy-confirm';
import type { DeleteConfirmPayload } from './types/delete-confirm';
import type { FileDiffPayload } from './types/diff';
import type { LlmStatusPayload, PlannerProgress, PlannerStep } from './types/llm';

export type ParsedAgentStreamPayload =
  | { type: 'chunk'; delta: string; streamTag?: string }
  | { type: 'tool_read_chunk'; delta: string }
  | { type: 'tool_exec_chunk'; delta: string; streamTag?: string; label?: string }
  | { type: 'tool_exec_complete'; streamTag?: string; label?: string; exitCode?: number | null }
  | { type: 'status'; status: LlmStatusPayload }
  | { type: 'planner'; planner: PlannerProgress }
  | { type: 'diff'; diff: FileDiffPayload }
  | { type: 'accept_command'; acceptCommand: AcceptCommandPayload }
  | { type: 'copy_confirm'; copyConfirm: CopyConfirmPayload }
  | { type: 'delete_confirm'; deleteConfirm: DeleteConfirmPayload };

type RawAgentStreamPayload = {
  type?: string;
  delta?: string;
  stream_tag?: string;
  label?: string;
  exit_code?: unknown;
  status?: LlmStatusPayload & { agent_role?: string; stream_tag?: string };
  planner?: PlannerProgress;
  diff?: unknown;
  acceptCommand?: unknown;
  copyConfirm?: unknown;
  deleteConfirm?: unknown;
};

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const _PLANNER_PHASES: ReadonlySet<PlannerProgress['phase']> = new Set([
  'discovery',
  'planning',
  'executing',
  'complete',
  'error',
]);

const _STEP_STATES: ReadonlySet<PlannerStep['state']> = new Set([
  'pending',
  'running',
  'complete',
  'error',
]);

/** Coerce backend planner dicts so the renderer never sees missing `steps` or invalid shapes. */
export function normalizePlannerProgress(raw: unknown): PlannerProgress {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const stRaw = p['streamTag'];
  const streamTag =
    typeof stRaw === 'string' && stRaw.trim() ? stRaw.trim() : 'planner';
  const phaseRaw = p['phase'];
  const phase = _PLANNER_PHASES.has(phaseRaw as PlannerProgress['phase'])
    ? (phaseRaw as PlannerProgress['phase'])
    : 'discovery';
  const rawSteps = p['steps'];
  const steps: PlannerStep[] = [];
  if (Array.isArray(rawSteps)) {
    for (const item of rawSteps) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Record<string, unknown>;
      const idRaw = s['id'];
      const id = typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : `step-${steps.length + 1}`;
      const textRaw = s['text'];
      const text = typeof textRaw === 'string' ? textRaw : '';
      const stateRaw = s['state'];
      const st = _STEP_STATES.has(stateRaw as PlannerStep['state'])
        ? (stateRaw as PlannerStep['state'])
        : 'pending';
      steps.push({ id, text, state: st });
    }
  }
  const planReadyRaw = p['planReady'];
  const out: PlannerProgress = {
    streamTag,
    phase,
    steps,
    planReady: typeof planReadyRaw === 'boolean' ? planReadyRaw : false,
  };
  const activeStepId = p['activeStepId'];
  if (typeof activeStepId === 'string' && activeStepId.trim()) {
    out.activeStepId = activeStepId.trim();
  }
  const finalReviewState = p['finalReviewState'];
  if (_STEP_STATES.has(finalReviewState as PlannerStep['state'])) {
    out.finalReviewState = finalReviewState as PlannerStep['state'];
  }
  const finalReviewAttempts = p['finalReviewAttempts'];
  if (typeof finalReviewAttempts === 'number' && Number.isFinite(finalReviewAttempts)) {
    out.finalReviewAttempts = finalReviewAttempts;
  }
  const finalReviewMaxAttempts = p['finalReviewMaxAttempts'];
  if (typeof finalReviewMaxAttempts === 'number' && Number.isFinite(finalReviewMaxAttempts)) {
    out.finalReviewMaxAttempts = finalReviewMaxAttempts;
  }
  const finalReviewSummary = p['finalReviewSummary'];
  if (typeof finalReviewSummary === 'string' && finalReviewSummary.trim()) {
    out.finalReviewSummary = finalReviewSummary.trim();
  }
  return out;
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

    if (parsed.type === 'planner' && parsed.planner && typeof parsed.planner === 'object') {
      return { type: 'planner', planner: normalizePlannerProgress(parsed.planner) };
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
      return {
        type: 'tool_exec_complete',
        streamTag: optionalTrimmedString(parsed.stream_tag),
        label: optionalTrimmedString(parsed.label),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    }

    if (parsed.type === 'chunk' && typeof parsed.delta === 'string') {
      return {
        type: 'chunk',
        delta: parsed.delta,
        streamTag: optionalTrimmedString(parsed.stream_tag),
      };
    }
  } catch {
    // Fall through to plain text chunks.
  }

  return { type: 'chunk', delta: payload };
}
