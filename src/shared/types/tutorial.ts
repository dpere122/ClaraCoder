/** Unversioned persisted progress uses this schema. Bump only with a migration plan. */
export const TUTORIAL_PROGRESS_SCHEMA_VERSION = 1;

/** Stable IDs are persisted in config.json. Never reuse an ID for a different phase or step. */
export const TUTORIAL_PHASE_REGISTRY = [
  {
    id: 'intro',
    steps: ['welcome', 'home-start', 'home-workspace', 'home-navigation', 'home-models', 'home-dependencies'],
  },
  { id: 'local-engine', steps: ['engine-intro', 'engine-install'] },
  {
    id: 'featured-models',
    steps: [
      'home-model-manager',
      'featured-intro',
      'featured-small',
      'featured-largest',
      'featured-preview',
      'featured-uploader',
      'featured-quantizations',
    ],
  },
  {
    id: 'local-source',
    steps: [
      'sources-navigation',
      'sources-add',
      'sources-model',
      'sources-defaults',
      'sources-advanced',
      'sources-apply',
      'celebration',
    ],
  },
] as const;

export interface TutorialPhaseDefinition {
  readonly id: string;
  readonly steps: readonly string[];
}

export type TutorialPhaseId = (typeof TUTORIAL_PHASE_REGISTRY)[number]['id'];
export type TutorialStepId = (typeof TUTORIAL_PHASE_REGISTRY)[number]['steps'][number];
export type TutorialWindow = 'home' | 'dependencies' | 'settings';
export type TutorialPhaseResolution = 'completed' | 'skipped' | 'dismissed';

/** Strings, rather than only the currently known union, let newer cursors survive a downgrade. */
export interface TutorialCursor {
  phaseId: string;
  stepId: string;
}

export interface TutorialProgress {
  /** Missing means version 1; later schema versions are preserved but not mutated. */
  schemaVersion?: number;
  revision: number;
  /** Unknown phase IDs and opaque records are retained for newer releases. */
  phases: Record<string, unknown>;
  active: TutorialCursor | null;
  /** ID only, never draft contents; lets a reopened Settings window detect a discarded source. */
  sourceId?: string;
}

export interface TutorialSnapshot {
  progress: TutorialProgress;
  /** Electron webContents id; ownership is transient and is never written to config.json. */
  ownerId: number | null;
  requestedWindow: TutorialWindow | null;
}

export interface TutorialTransition {
  expectedRevision: number;
  action: 'start' | 'advance' | 'skip-phase' | 'dismiss-all' | 'recover-source' | 'restart';
  /** Supplied only when advancing after the user creates a managed source draft. */
  sourceId?: string;
}

export interface TutorialTransitionResult {
  applied: boolean;
  snapshot: TutorialSnapshot;
}

export interface TutorialClaimResult {
  acquired: boolean;
  snapshot: TutorialSnapshot;
}

export function createDefaultTutorialProgress(): TutorialProgress {
  return { revision: 0, phases: {}, active: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownTutorialPhaseResolution(value: unknown): value is TutorialPhaseResolution {
  return value === 'completed' || value === 'skipped' || value === 'dismissed';
}

/**
 * Only an absent record is actionable. A future or malformed record is opaque to this
 * release, so treat it as resolved for scheduling rather than overwriting it.
 */
export function isTutorialPhaseResolved(value: unknown): boolean {
  return value !== undefined;
}

/** Unversioned progress is version 1. A newer/unknown schema must remain read-only. */
export function isTutorialProgressSupported(value: unknown): boolean {
  return !isRecord(value) || value['schemaVersion'] === undefined ||
    value['schemaVersion'] === TUTORIAL_PROGRESS_SCHEMA_VERSION;
}

/** Repair old progress without dropping unknown phase records or extension fields. */
export function normalizeTutorialProgress(value: unknown): TutorialProgress {
  if (!isRecord(value)) return createDefaultTutorialProgress();
  const revision = typeof value['revision'] === 'number' && Number.isSafeInteger(value['revision']) && value['revision'] >= 0
    ? value['revision']
    : 0;
  // Spread (rather than rebuild from known IDs) so phases from a newer version survive.
  const phases = isRecord(value['phases']) ? { ...value['phases'] } : {};
  const rawActive = value['active'];
  let active: TutorialCursor | null = null;
  if (isRecord(rawActive) && typeof rawActive['phaseId'] === 'string' && rawActive['phaseId'].length > 0 &&
      typeof rawActive['stepId'] === 'string' && rawActive['stepId'].length > 0) {
    const phase = TUTORIAL_PHASE_REGISTRY.find((item) => item.id === rawActive['phaseId']);
    const knownStep = phase && (phase.steps as readonly string[]).includes(rawActive['stepId']);
    // Repair contradictory v1 cursors only when we understand both the phase and step.
    // A future cursor (or a future schema) is never discarded by an older release.
    if (!isTutorialProgressSupported(value) || !knownStep || !isKnownTutorialPhaseResolution(phases[rawActive['phaseId']])) {
      active = { ...rawActive, phaseId: rawActive['phaseId'], stepId: rawActive['stepId'] };
    }
  }
  return { ...value, revision, phases, active } as TutorialProgress;
}

/** Forward transitions are registry-defined; the only rewinds are lost-source recovery and an explicit restart. */
export function applyTutorialTransition(
  current: TutorialProgress,
  request: TutorialTransition,
  registry: readonly TutorialPhaseDefinition[] = TUTORIAL_PHASE_REGISTRY,
): { applied: boolean; progress: TutorialProgress } {
  if (!isTutorialProgressSupported(current) || !request || !Number.isSafeInteger(current.revision) || current.revision < 0 ||
    current.revision >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision !== current.revision) {
    return { applied: false, progress: current };
  }
  const phases = { ...current.phases };
  const firstUnresolved = (): TutorialCursor | null => {
    const phase = registry.find((item) => item.steps.length > 0 && !isTutorialPhaseResolved(phases[item.id]));
    return phase ? { phaseId: phase.id, stepId: phase.steps[0]! } : null;
  };
  let active = current.active;
  let changed = false;

  if (request.action === 'start') {
    if (!active) {
      active = firstUnresolved();
      changed = active !== null;
    }
  } else if (request.action === 'dismiss-all') {
    const activePhase = active ? registry.find((phase) => phase.id === active!.phaseId) : undefined;
    const unknownStep = !!activePhase && !!active && !activePhase.steps.includes(active.stepId);
    for (const phase of registry) {
      // An unfamiliar step in a known phase belongs to a newer release, too.
      if (unknownStep && phase.id === active!.phaseId) continue;
      if (!isTutorialPhaseResolved(phases[phase.id])) {
        phases[phase.id] = 'dismissed';
        changed = true;
      }
    }
    if (activePhase && !unknownStep && !isTutorialPhaseResolved(current.phases[activePhase.id])) {
      active = null;
      changed = true;
    }
  } else if (request.action === 'recover-source' && active?.phaseId === 'local-source' && typeof current.sourceId === 'string' && current.sourceId) {
    const phase = registry.find((item) => item.id === 'local-source');
    const addIndex = phase?.steps.indexOf('sources-add') ?? -1;
    const currentIndex = phase?.steps.indexOf(active.stepId) ?? -1;
    if (addIndex >= 0 && currentIndex > addIndex && !isTutorialPhaseResolved(phases['local-source'])) {
      active = { ...active, phaseId: 'local-source', stepId: 'sources-add' };
      changed = true;
    }
  } else if (request.action === 'restart') {
    // Re-offer only a finished or dismissed tour. Opaque records and a future cursor belong to a newer release.
    if (!active && !firstUnresolved()) {
      for (const phase of registry) {
        if (isKnownTutorialPhaseResolution(phases[phase.id])) {
          delete phases[phase.id];
          changed = true;
        }
      }
    }
  } else if ((request.action === 'advance' || request.action === 'skip-phase') && active) {
    const phase = registry.find((item) => item.id === active!.phaseId);
    const index = phase?.steps.indexOf(active.stepId) ?? -1;
    if (phase && index >= 0 && !isTutorialPhaseResolved(phases[phase.id])) {
      if (request.action === 'skip-phase' || index === phase.steps.length - 1) {
        phases[phase.id] = request.action === 'skip-phase' ? 'skipped' : 'completed';
        active = firstUnresolved();
      } else {
        active = { ...active, phaseId: phase.id, stepId: phase.steps[index + 1]! };
      }
      changed = true;
    }
  }

  if (!changed) return { applied: false, progress: current };
  const progress: TutorialProgress = { ...current, revision: current.revision + 1, phases, active };
  if (request.action === 'advance' && current.active?.phaseId === 'local-source' && current.active.stepId === 'sources-add') {
    if (typeof request.sourceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(request.sourceId)) {
      progress.sourceId = request.sourceId;
    } else {
      delete progress.sourceId;
    }
  }
  if (request.action === 'recover-source' || request.action === 'restart' ||
      (current.active?.phaseId === 'local-source' && active?.phaseId !== 'local-source') ||
      (request.action === 'dismiss-all' && !active)) {
    delete progress.sourceId;
  }
  return { applied: true, progress };
}
