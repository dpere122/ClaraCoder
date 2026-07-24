/** Payload for SSE `plan_confirm` / chat plan approval card. */
export interface PlanConfirmResolvedQuestion {
  prompt: string;
  answer: string;
}

export type PlanFileOperation = 'create' | 'modify' | 'delete';

export interface PlanConfirmFileChange {
  path: string;
  operation: PlanFileOperation;
  rationale: string;
}

export interface PlanConfirmPayload {
  version: 1;
  requestId: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  steps: string[];
  /** Files the plan proposes to create, modify, or delete. */
  filesToChange: PlanConfirmFileChange[];
  /** Relevant existing behavior from discovery. */
  currentImplementation: string;
  /** Per-step risks unioned for at-a-glance review. */
  risks: string[];
  /** Plan-level outcomes that prove the objective is met. */
  definitionOfDone: string[];
  /** Open questions the user already answered during the question-card phase. */
  resolvedQuestions: PlanConfirmResolvedQuestion[];
  /** Workspace-relative path to the build plan markdown file (preview tab). */
  buildPlanPath?: string;
  /** Build plan id linked to the preview tab and cancel API. */
  planId?: string;
}

const PLAN_FILE_OPS = new Set<PlanFileOperation>(['create', 'modify', 'delete']);

function splitPathRationale(text: string): { path: string; rationale: string } {
  for (const sep of ['—', '–'] as const) {
    const idx = text.indexOf(sep);
    if (idx >= 0) {
      return {
        path: text.slice(0, idx).trim(),
        rationale: text.slice(idx + sep.length).trim(),
      };
    }
  }
  return { path: text.trim(), rationale: '' };
}

/** Normalize structured or legacy string `filesToChange` entries from SSE / persisted chats. */
export function normalizePlanConfirmFileChange(raw: unknown): PlanConfirmFileChange | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    const tagged = text.match(/^\[(create|modify|delete)\]\s+(.+)$/i);
    if (tagged) {
      const operation = tagged[1].toLowerCase() as PlanFileOperation;
      const { path, rationale } = splitPathRationale(tagged[2]);
      if (!path) return null;
      return { path, operation, rationale };
    }
    const { path, rationale } = splitPathRationale(text);
    if (!path) return null;
    return { path, operation: 'modify', rationale };
  }
  if (typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const path = String(obj['path'] ?? '').trim();
  if (!path) return null;
  const opRaw = String(obj['operation'] ?? 'modify').trim().toLowerCase();
  const operation = PLAN_FILE_OPS.has(opRaw as PlanFileOperation)
    ? (opRaw as PlanFileOperation)
    : 'modify';
  return {
    path,
    operation,
    rationale: String(obj['rationale'] ?? '').trim(),
  };
}

export function normalizePlanConfirmFilesToChange(raw: unknown): PlanConfirmFileChange[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanConfirmFileChange[] = [];
  for (const item of raw) {
    const entry = normalizePlanConfirmFileChange(item);
    if (entry) out.push(entry);
  }
  return out;
}
