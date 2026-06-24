import type { ConversationMessage, DiffReviewStatus, PlanConfirmPayload, PlannerProgress } from '@shared/index';
import { isClaraOuterBriefStreamTag, PLANNER_STREAM_TAG } from '@shared/index';
import { DEFAULT_AUXILIARY_STREAM_PANEL_TITLE } from './auxiliary-stream-panel/auxiliary-stream-panel';

/** Shown in the live processing row while tools are active; index chosen when tool phase starts. */
export const TOOL_BUILDING_SYNONYMS = [
  'assembling',
  'constructing',
  'compiling',
  'crafting',
  'fabricating',
  'forging',
  'generating',
  'producing',
  'shaping',
  'structuring',
  'erecting',
  'forming',
] as const;

/** Same shape as `ConversationMessage` in `typings.d.ts` (single source for save/load). */
export type ChatMessage = ConversationMessage;
type UserMessage = Extract<ChatMessage, { role: 'user' }>;
type ChainMessage = Extract<ChatMessage, { role: 'chain' }>;
export type ArtifactMessage = Extract<
  ChatMessage,
  { role: 'diff' | 'accept_command' | 'copy_confirm' | 'delete_confirm' | 'plan_confirm' | 'staged_transfer_batch' }
>;

export interface PlanPanelContext {
  planner: PlannerProgress;
  planConfirm?: PlanConfirmPayload;
  planConfirmReviewStatus?: DiffReviewStatus;
  planConfirmReviewSummary?: string;
}

function plannerFromPlanConfirm(payload: PlanConfirmPayload): PlannerProgress {
  return {
    streamTag: PLANNER_STREAM_TAG,
    phase: 'planning',
    planReady: true,
    steps: payload.steps.map((text, i) => ({
      id: `step-${i + 1}`,
      text,
      state: 'pending' as const,
    })),
  };
}

/** Merge live or persisted planner progress with an optional plan-confirm HITL artifact. */
export function planPanelContext(
  planner: PlannerProgress | null | undefined,
  artifacts: readonly ArtifactMessage[],
): PlanPanelContext | null {
  const planArtifact = artifacts.find((a): a is Extract<ArtifactMessage, { role: 'plan_confirm' }> => a.role === 'plan_confirm');
  if (planner) {
    return {
      planner,
      planConfirm: planArtifact?.payload,
      planConfirmReviewStatus: planArtifact?.reviewStatus,
      planConfirmReviewSummary: planArtifact?.reviewSummary,
    };
  }
  if (planArtifact) {
    return {
      planner: plannerFromPlanConfirm(planArtifact.payload),
      planConfirm: planArtifact.payload,
      planConfirmReviewStatus: planArtifact.reviewStatus ?? 'pending',
      planConfirmReviewSummary: planArtifact.reviewSummary,
    };
  }
  return null;
}

/** True when the unified plan checklist should render for this turn. */
export function turnHasPlanPanel(
  planner: PlannerProgress | null | undefined,
  artifacts: readonly ArtifactMessage[],
): boolean {
  return planPanelContext(planner, artifacts) != null;
}

/** Plan is the terminal UI — no streamed final prose yet — so present like a completed turn. */
export function liveTurnPresentationSettled(
  planVisible: boolean,
  rawPrimaryText: string,
  livePrimaryText: string,
): boolean {
  if (!planVisible) {
    return false;
  }
  return rawPrimaryText.trim().length === 0 && livePrimaryText.trim().length === 0;
}

/** Plan approval is rendered inside the unified plan panel — omit from the HITL detail stack. */
export function hitlArtifactsExcludingPlanConfirm(artifacts: readonly ArtifactMessage[]): ArtifactMessage[] {
  return artifacts.filter((a) => a.role !== 'plan_confirm');
}

export function planPanelCompleteCount(planner: PlannerProgress): number {
  return planner.steps.filter((s) => s.state === 'complete').length;
}

export interface ToolChainGroup {
  key: string;
  rows: ChainMessage[];
  toolCallCount: number;
}

export type ChatDisplayRow =
  | { kind: 'user'; msg: UserMessage }
  | {
      kind: 'assistant-turn';
      assistant: Extract<ChatMessage, { role: 'assistant' }> | null;
      chainGroups: ToolChainGroup[];
      artifacts: ArtifactMessage[];
    };

/** Inline image data URLs attached to a user turn (from `image_url` blocks). */
export function userMessageImageUrls(msg: UserMessage): string[] {
  const parts = msg.structuredContent;
  if (!parts?.length) {
    return [];
  }
  const urls: string[] = [];
  for (const part of parts) {
    const rec = part as { type?: unknown; image_url?: { url?: unknown } };
    if (String(rec.type ?? '') === 'image_url') {
      const url = rec.image_url?.url;
      if (typeof url === 'string' && url) {
        urls.push(url);
      }
    }
  }
  return urls;
}

const ATTACHED_FILE_PREFIX = 'Attached file: ';

/** Workspace-relative paths of non-image files referenced in a user turn. */
export function userMessageAttachedFiles(msg: UserMessage): string[] {
  const parts = msg.structuredContent;
  if (!parts?.length) {
    return [];
  }
  const files: string[] = [];
  for (const part of parts) {
    const rec = part as { type?: unknown; text?: unknown };
    if (String(rec.type ?? '') === 'text' && typeof rec.text === 'string' && rec.text.startsWith(ATTACHED_FILE_PREFIX)) {
      files.push(rec.text.slice(ATTACHED_FILE_PREFIX.length));
    }
  }
  return files;
}

export function isScrollWorthyAppendMessage(m: ChatMessage): boolean {
  return (
    m.role === 'user' ||
    m.role === 'assistant' ||
    m.role === 'chain' ||
    m.role === 'diff' ||
    m.role === 'delete_confirm' ||
    m.role === 'copy_confirm' ||
    m.role === 'accept_command' ||
    m.role === 'plan_confirm' ||
    m.role === 'staged_transfer_batch'
  );
}

/** Review / confirmation cards (HITL): always scroll into view, including while a reply is still streaming. */
export function isHitlActivationMessage(m: ChatMessage): boolean {
  return (
    m.role === 'diff' ||
    m.role === 'delete_confirm' ||
    m.role === 'copy_confirm' ||
    m.role === 'accept_command' ||
    m.role === 'plan_confirm' ||
    m.role === 'staged_transfer_batch'
  );
}

/** HITL card still awaiting user action (blocks the live streaming row until resolved). */
export function isPendingHitlArtifact(m: ArtifactMessage): boolean {
  return (m.reviewStatus ?? 'pending') === 'pending';
}

export function turnHasPendingHitlArtifacts(artifacts: readonly ArtifactMessage[]): boolean {
  return artifacts.some(isPendingHitlArtifact);
}

/** In-flight assistant turn for the live bubble (no final ``assistant`` message yet). */
export function resolveLiveAssistantTurn(
  rows: readonly ChatDisplayRow[],
): Extract<ChatDisplayRow, { kind: 'assistant-turn' }> | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === 'assistant-turn' && !row.assistant) {
      return row;
    }
    if (row?.kind === 'user') {
      return null;
    }
  }
  return null;
}

/** Small stable hash for synonym index (FNV-1a 32-bit). */
export function hashChatToolPhaseKey(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function buildToolChainGroup(rows: ChainMessage[], index: number): ToolChainGroup {
  const visibleRows = rows.filter(
    (row) => row.source === 'tool' || isClaraOuterBriefStreamTag(row.streamTag),
  );
  return {
    key: rows[0]?.statusId ?? `tool-chain-${index}`,
    rows: visibleRows,
    toolCallCount: visibleRows.filter((row) => row.source === 'tool').length,
  };
}

export function filterLiveToolChainGroups(groups: ToolChainGroup[]): ToolChainGroup[] {
  return groups.filter((group) => group.rows.length > 0);
}

function oneLineTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract the latest non-empty line from streaming text for the panel title.
 * During streaming, briefs update the panel title instead of appearing in the main response.
 */
export function extractLatestBriefLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) {
      const title = oneLineTitle(line);
      return title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
    }
  }
  return '';
}

/** Live markdown zone: only backend `final_text`, never interim agent stream chunks. */
export function resolvePrimaryStreamLiveText(streamingFinalText: string | undefined): string {
  const final = streamingFinalText?.trim();
  return final ?? '';
}

export function auxiliaryPanelTitleFromChainGroups(groups: readonly ToolChainGroup[]): string {
  for (let i = groups.length - 1; i >= 0; i--) {
    const rows = groups[i].rows;
    for (let j = rows.length - 1; j >= 0; j--) {
      const row = rows[j];
      if (!isClaraOuterBriefStreamTag(row.streamTag)) {
        continue;
      }
      const title = oneLineTitle(row.text || row.label);
      if (!title) {
        continue;
      }
      return title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
    }
  }
  return DEFAULT_AUXILIARY_STREAM_PANEL_TITLE;
}

export function buildChatDisplayRows(messages: ChatMessage[]): ChatDisplayRow[] {
  const rows: ChatDisplayRow[] = [];
  const pendingArtifacts: ArtifactMessage[] = [];
  const pendingChainGroups: ToolChainGroup[] = [];
  let pendingChainRows: ChainMessage[] = [];
  let chainGroupIndex = 0;

  const flushChainGroup = (): void => {
    if (pendingChainRows.length === 0) return;
    const group = buildToolChainGroup([...pendingChainRows], chainGroupIndex++);
    pendingChainRows = [];
    if (group.rows.length === 0) return;
    pendingChainGroups.push(group);
  };

  const flushPendingAssistantTurn = (): void => {
    flushChainGroup();
    if (pendingChainGroups.length === 0 && pendingArtifacts.length === 0) return;
    rows.push({
      kind: 'assistant-turn',
      assistant: null,
      chainGroups: [...pendingChainGroups],
      artifacts: [...pendingArtifacts],
    });
    pendingChainGroups.length = 0;
    pendingArtifacts.length = 0;
  };

  for (const msg of messages) {
    if (msg.role === 'user') {
      flushPendingAssistantTurn();
      rows.push({ kind: 'user', msg });
      continue;
    }
    if (msg.role === 'chain') {
      pendingChainRows.push(msg);
      continue;
    }
    if (
      msg.role === 'diff' ||
      msg.role === 'copy_confirm' ||
      msg.role === 'delete_confirm' ||
      msg.role === 'plan_confirm' ||
      msg.role === 'staged_transfer_batch'
    ) {
      flushChainGroup();
      pendingArtifacts.push(msg);
      continue;
    }
    if (msg.role === 'accept_command') {
      flushChainGroup();
      pendingArtifacts.push(msg);
      continue;
    }
    flushChainGroup();
    rows.push({
      kind: 'assistant-turn',
      assistant: msg,
      chainGroups: [...pendingChainGroups],
      artifacts: [...pendingArtifacts],
    });
    pendingChainGroups.length = 0;
    pendingArtifacts.length = 0;
  }

  flushPendingAssistantTurn();
  return rows;
}
