export const COMPOSER_RUN_MODES = ['agent', 'plan'] as const;

export type ComposerRunMode = (typeof COMPOSER_RUN_MODES)[number];

export const DEFAULT_COMPOSER_RUN_MODE: ComposerRunMode = 'agent';

export const COMPOSER_RUN_MODE_LABELS: Record<ComposerRunMode, string> = {
  agent: 'Agent',
  plan: 'Plan',
};
