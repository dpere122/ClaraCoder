/** Allowed values for the composer run-mode selector. `ask` is UI-only (maps to read-only agent). */
export const COMPOSER_RUN_MODES = ['ask', 'agent', 'plan'] as const;

/** Backend `composer_mode` values (excludes UI-only `ask`). */
export type ComposerBackendMode = 'agent' | 'plan';

/**
 * How the next chat turn is executed.
 *
 * - `agent` — single ReAct agent runs tools directly (with edit tools).
 * - `ask` — read-only Q&A: same agent path but no workspace write/edit tools (UI-only; maps to `agent` + `apply_mode=false`).
 * - `plan` — plan-and-execute orchestrator drafts steps and waits for approval before execution.
 */
export type ComposerRunMode = (typeof COMPOSER_RUN_MODES)[number];

/** Initial run mode for new sessions and when the composer mounts. */
export const DEFAULT_COMPOSER_RUN_MODE: ComposerRunMode = 'agent';

/** UI labels for {@link COMPOSER_RUN_MODES} entries in the composer `<select>`. */
export const COMPOSER_RUN_MODE_LABELS: Record<ComposerRunMode, string> = {
  agent: 'Agent',
  ask: 'Ask',
  plan: 'Plan',
};

/** Whether workspace edit tools are bound for this composer mode. */
export function composerApplyMode(mode: ComposerRunMode): boolean {
  return mode !== 'ask';
}

/** Map UI composer mode to the backend `composer_mode` field. */
export function composerModeForBackend(mode: ComposerRunMode): ComposerBackendMode {
  return mode === 'plan' ? 'plan' : 'agent';
}
