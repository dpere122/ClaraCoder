/**
 * Settings → Subagents: the roles the main agent can hand work to and where each one runs.
 * Shared by the Settings window, config migration and the Python sync.
 */

/** Tool groups a role can be limited to, in the order Settings lists them. */
export const SUBAGENT_TOOL_GROUPS = [
  { id: 'read', label: 'Read files' },
  { id: 'search', label: 'Search' },
  { id: 'lsp', label: 'Language servers' },
  { id: 'web', label: 'Web' },
  { id: 'commands', label: 'Run commands' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'edit', label: 'Edit files' },
] as const;

export type SubagentToolGroup = (typeof SUBAGENT_TOOL_GROUPS)[number]['id'];

/** Groups a read only role never gets: the backend binds them in Editor mode only. */
export const SUBAGENT_EDITOR_ONLY_TOOL_GROUPS: readonly SubagentToolGroup[] = ['commands', 'mcp', 'edit'];

export const SUBAGENT_CLOUD_LIMIT_MIN = 1;
export const SUBAGENT_CLOUD_LIMIT_MAX = 16;
export const SUBAGENT_ROLES_MAX = 32;
export const SUBAGENT_ROLE_NAME_MAX = 40;

/** A role's thinking: the source's own setting, or forced on or off for this kind of work. */
export type SubagentThinking = 'source' | 'on' | 'off';

/** Reasoning effort levels a role can ask for, weakest first, with their labels in Settings. */
export const SUBAGENT_THINKING_LEVELS = [
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
] as const;

export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number]['id'];

/** What happens when a role's source is gone or not running. */
export type SubagentFallback = 'main' | 'fail';

export interface SubagentRoleConfig {
  id: string;
  /** What the main agent passes as the role; unique among roles (case-insensitive). */
  name: string;
  /** When the main agent should use it; part of the spawn tool's description. */
  description: string;
  enabled: boolean;
  /** Id of the source (`LlmProviderConfig.id`) it runs on; empty follows the main agent's source. */
  connectionId: string;
  /**
   * Model on the source the role names; empty keeps the source's own model. Always empty for a
   * role that follows the main agent's source: it takes that source's model, whichever it is.
   */
  model: string;
  /** Never gets Editor tools, whatever mode the chat is in. */
  readOnly: boolean;
  thinking: SubagentThinking;
  /** Reasoning effort; empty keeps the source's own level. */
  thinkingLevel: SubagentThinkingLevel | '';
  tools: SubagentToolGroup[];
  /** Appended to the sub-agent's system prompt. */
  instructions: string;
}

export interface SubagentsConfig {
  /** Off: the main agent has no sub-agent tools at all. */
  enabled: boolean;
  /** Sub-agents one conversation runs at once on a cloud source (a local source runs one). */
  cloudConcurrency: number;
  fallback: SubagentFallback;
  /** Empty: the main agent starts plain copies of itself, as before roles existed. */
  roles: SubagentRoleConfig[];
}

/**
 * The catalog and limits for a view. Functions, because the renderer's multi-file test bundle gives
 * a component a stale copy of a shared constant when its spec is the first to load this module.
 */
export function subagentToolGroups(): typeof SUBAGENT_TOOL_GROUPS {
  return SUBAGENT_TOOL_GROUPS;
}

export function subagentLimits(): { cloudMin: number; cloudMax: number; rolesMax: number } {
  return { cloudMin: SUBAGENT_CLOUD_LIMIT_MIN, cloudMax: SUBAGENT_CLOUD_LIMIT_MAX, rolesMax: SUBAGENT_ROLES_MAX };
}

/**
 * The levels to offer a role, by what its source's model accepts: `offered` when the source
 * reports a list (Claude's effort levels), none for a model whose thinking is only on or off
 * (the Gemma preset), the Qwen three for that preset, and the common five otherwise.
 */
export function subagentThinkingLevelOptions(
  preset: string | undefined,
  offered?: readonly string[] | null,
): { id: SubagentThinkingLevel; label: string }[] {
  let ids: readonly string[];
  if (offered && offered.length > 0) {
    ids = offered;
  } else if (preset === 'gemma') {
    ids = [];
  } else if (preset === 'qwen') {
    ids = ['low', 'medium', 'xhigh'];
  } else {
    ids = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  }
  return SUBAGENT_THINKING_LEVELS.filter((level) => ids.includes(level.id));
}

export function isEditorOnlySubagentToolGroup(group: SubagentToolGroup): boolean {
  return SUBAGENT_EDITOR_ONLY_TOOL_GROUPS.includes(group);
}

const ALL_TOOL_GROUPS: SubagentToolGroup[] = SUBAGENT_TOOL_GROUPS.map((group) => group.id);

export function defaultSubagentsConfig(): SubagentsConfig {
  return { enabled: true, cloudConcurrency: 3, fallback: 'main', roles: [] };
}

/** A new role with every tool group on; the caller supplies a fresh id and a free name. */
export function newSubagentRole(id: string, name: string): SubagentRoleConfig {
  return {
    id,
    name,
    description: '',
    enabled: true,
    connectionId: '',
    model: '',
    readOnly: false,
    thinking: 'source',
    thinkingLevel: '',
    tools: [...ALL_TOOL_GROUPS],
    instructions: '',
  };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function normalizeTools(value: unknown): SubagentToolGroup[] {
  if (!Array.isArray(value)) {
    return [...ALL_TOOL_GROUPS];
  }
  return ALL_TOOL_GROUPS.filter((group) => value.includes(group));
}

/** A name the model can type: single spaces, no backticks, capped. */
export function cleanSubagentRoleName(value: unknown): string {
  return text(value, 200).replace(/`/g, '').split(/\s+/).filter(Boolean).join(' ').slice(0, SUBAGENT_ROLE_NAME_MAX);
}

/**
 * `stem` with a number after it, inside the name cap: the stem gives way, never the number, so
 * cleaning the name on save cannot cut it back to a name that is already taken.
 */
export function numberedSubagentRoleName(stem: string, n: number): string {
  const suffix = ` ${n}`;
  return `${stem.slice(0, SUBAGENT_ROLE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Coerce stored or edited settings into a valid shape. Roles keep their order; a role without an id
 * or name is dropped, and a repeated id or name (case-insensitive) keeps the first.
 */
export function normalizeSubagentsConfig(raw: unknown): SubagentsConfig {
  const base = defaultSubagentsConfig();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const source = raw as Record<string, unknown>;
  const limit = typeof source['cloudConcurrency'] === 'number' ? Math.round(source['cloudConcurrency']) : NaN;
  const roles: SubagentRoleConfig[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of Array.isArray(source['roles']) ? source['roles'] : []) {
    if (!item || typeof item !== 'object' || roles.length >= SUBAGENT_ROLES_MAX) {
      continue;
    }
    const role = item as Record<string, unknown>;
    const id = text(role['id'], 80).trim();
    const name = cleanSubagentRoleName(role['name']);
    if (!id || !name || ids.has(id) || names.has(name.toLowerCase())) {
      continue;
    }
    ids.add(id);
    names.add(name.toLowerCase());
    const connectionId = text(role['connectionId'], 200).trim();
    roles.push({
      id,
      name,
      description: text(role['description'], 400),
      enabled: role['enabled'] !== false,
      connectionId,
      // A model id means something on one source only, and the main agent's source can change.
      model: connectionId ? text(role['model'], 200).trim() : '',
      readOnly: role['readOnly'] === true,
      thinking: role['thinking'] === 'on' || role['thinking'] === 'off' ? role['thinking'] : 'source',
      thinkingLevel: SUBAGENT_THINKING_LEVELS.find((level) => level.id === role['thinkingLevel'])?.id ?? '',
      tools: normalizeTools(role['tools']),
      instructions: text(role['instructions'], 4000),
    });
  }
  return {
    enabled: source['enabled'] !== false,
    cloudConcurrency: Number.isFinite(limit)
      ? Math.min(SUBAGENT_CLOUD_LIMIT_MAX, Math.max(SUBAGENT_CLOUD_LIMIT_MIN, limit))
      : base.cloudConcurrency,
    fallback: source['fallback'] === 'fail' ? 'fail' : 'main',
    roles,
  };
}
