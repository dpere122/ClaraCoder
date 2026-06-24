/** Allowed values for the composer run-mode selector (mirrors backend `composer_mode`). */
export const COMPOSER_RUN_MODES = ['agent', 'plan'] as const;

/**
 * How the next chat turn is executed.
 *
 * - `agent` — single ReAct agent runs tools directly.
 * - `plan` — plan-and-execute orchestrator drafts steps and waits for approval before execution.
 */
export type ComposerRunMode = (typeof COMPOSER_RUN_MODES)[number];

/** Initial run mode for new sessions and when the composer mounts. */
export const DEFAULT_COMPOSER_RUN_MODE: ComposerRunMode = 'agent';

/** UI labels for {@link COMPOSER_RUN_MODES} entries in the composer `<select>`. */
export const COMPOSER_RUN_MODE_LABELS: Record<ComposerRunMode, string> = {
  agent: 'Agent',
  plan: 'Plan',
};
