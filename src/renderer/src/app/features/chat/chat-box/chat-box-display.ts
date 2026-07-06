import type {
  ConversationMessage,
  DiffReviewStatus,
  PlanConfirmPayload,
  AgentQuestionPayload,
  PlannerProgress,
  StreamPart,
} from '@shared/index';
import { isClaraOuterBriefStreamTag, isPrimaryAssistantStreamTag, PLANNER_STREAM_TAG } from '@shared/index';
import { DEFAULT_AUXILIARY_STREAM_PANEL_TITLE } from './auxiliary-stream-panel/auxiliary-stream-panel';
import {
  attachedFileDisplayLabel,
  attachedFileRefFromText,
  isAttachedFileText,
} from '../chat-context-bar/chat-attached-file-display';

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
  | { role: 'diff' }
  | { role: 'accept_command' }
  | { role: 'copy_confirm' }
  | { role: 'delete_confirm' }
  | { role: 'plan_confirm' }
  | { role: 'agent_question' }
  | { role: 'staged_transfer_batch' }
>;

export interface PlanPanelContext {
  planner: PlannerProgress;
  planConfirm?: PlanConfirmPayload;
  planConfirmReviewStatus?: DiffReviewStatus;
  planConfirmReviewSummary?: string;
  agentQuestion?: AgentQuestionPayload;
  agentQuestionReviewStatus?: DiffReviewStatus;
  agentQuestionReviewSummary?: string;
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

/** Merge live or persisted planner progress with optional plan-confirm / agent-question HITL artifacts. */
export function planPanelContext(
  planner: PlannerProgress | null | undefined,
  artifacts: readonly ArtifactMessage[],
): PlanPanelContext | null {
  const planArtifact = artifacts.find((a): a is Extract<ArtifactMessage, { role: 'plan_confirm' }> => a.role === 'plan_confirm');
  const questionArtifact = artifacts.find(
    (a): a is Extract<ArtifactMessage, { role: 'agent_question' }> => a.role === 'agent_question',
  );
  if (planner) {
    return {
      planner,
      planConfirm: planArtifact?.payload,
      planConfirmReviewStatus: planArtifact?.reviewStatus,
      planConfirmReviewSummary: planArtifact?.reviewSummary,
      agentQuestion: questionArtifact?.payload,
      agentQuestionReviewStatus: questionArtifact?.reviewStatus,
      agentQuestionReviewSummary: questionArtifact?.reviewSummary,
    };
  }
  if (planArtifact) {
    return {
      planner: plannerFromPlanConfirm(planArtifact.payload),
      planConfirm: planArtifact.payload,
      planConfirmReviewStatus: planArtifact.reviewStatus ?? 'pending',
      planConfirmReviewSummary: planArtifact.reviewSummary,
      agentQuestion: questionArtifact?.payload,
      agentQuestionReviewStatus: questionArtifact?.reviewStatus,
      agentQuestionReviewSummary: questionArtifact?.reviewSummary,
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

/** Plan approval + clarifying questions are rendered inside the unified plan panel — omit from the HITL detail stack. */
export function hitlArtifactsExcludingPlanConfirm(artifacts: readonly ArtifactMessage[]): ArtifactMessage[] {
  return artifacts.filter((a) => a.role !== 'plan_confirm' && a.role !== 'agent_question');
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

/** Display labels for non-image file attachments in a user turn. */
export function userMessageAttachedFiles(msg: UserMessage): string[] {
  const parts = msg.structuredContent;
  if (!parts?.length) {
    return [];
  }
  const files: string[] = [];
  for (const part of parts) {
    const rec = part as { type?: unknown; text?: unknown };
    if (String(rec.type ?? '') === 'text' && typeof rec.text === 'string' && isAttachedFileText(rec.text)) {
      const ref = attachedFileRefFromText(rec.text);
      if (ref) {
        files.push(attachedFileDisplayLabel(ref));
      }
    }
  }
  return files;
}

/** Raw attachment text after the prefix (path or path + line-range hint). */
export function userMessageAttachedFileRefs(msg: UserMessage): string[] {
  const parts = msg.structuredContent;
  if (!parts?.length) {
    return [];
  }
  const files: string[] = [];
  for (const part of parts) {
    const rec = part as { type?: unknown; text?: unknown };
    if (String(rec.type ?? '') === 'text' && typeof rec.text === 'string' && isAttachedFileText(rec.text)) {
      const ref = attachedFileRefFromText(rec.text);
      if (ref) {
        files.push(ref);
      }
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
    m.role === 'agent_question' ||
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
    m.role === 'agent_question' ||
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

/** Primary (`agent`) prose from the latest model step — after tool multiplex rows split segments. */
export function latestPrimaryStreamSegmentText(parts: readonly StreamPart[]): string {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (isPrimaryAssistantStreamTag(part.streamTag)) {
      return part.text;
    }
  }
  return '';
}

/**
 * Extract the latest non-empty line from streaming text for the panel title.
 * Used for Clara status lines while tools run and the main reply zone is empty.
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

/**
 * Live markdown zone: prefer backend `final_text`, else stream the latest primary agent segment.
 * Suppresses pre-tool brief prose in the main zone while tools are actively running.
 */
export function resolvePrimaryStreamLiveText(
  streamingFinalText: string | undefined,
  streamingParts: readonly StreamPart[],
  processingToolsActive: boolean,
): string {
  const final = streamingFinalText?.trim();
  if (final) {
    return final;
  }
  if (processingToolsActive) {
    return '';
  }
  return latestPrimaryStreamSegmentText(streamingParts).trim();
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
      msg.role === 'agent_question' ||
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
