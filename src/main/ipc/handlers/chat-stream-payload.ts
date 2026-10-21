import type { ParsedAgentStreamPayload } from '../../../shared';
import { parseAgentStreamPayload } from '../../../shared';
import { appendConversationFileJournal } from '../../conversations-db';

export const parseStreamPayload = parseAgentStreamPayload;

type FileJournalRow = Extract<ParsedAgentStreamPayload, { type: 'file_journal' }>['fileJournal'];

/**
 * Persist a `file_journal` row here, where the stream's conversation id is known, so the
 * end-of-turn snapshot at `[DONE]` never races a renderer round-trip.
 */
export function persistFileJournal(conversationId: string, row: FileJournalRow): void {
  try {
    appendConversationFileJournal({ conversationId, ...row });
  } catch (err) {
    console.error('[Chat] Failed to persist file journal row:', err);
  }
}

/** Delivers one renderer IPC message (a chat stream's `event.reply`, or the main window's `send`). */
export type RendererSend = (channel: string, ...args: unknown[]) => void;

/** `event.reply` of a chat stream: its messages reach only the frame that sent the turn. */
export function replyTo(event: Electron.IpcMainEvent): RendererSend {
  return (channel, ...args) => event.reply(channel, ...args);
}

/**
 * Map one parsed stream payload to the renderer IPC channel(s) for this conversation. `target` is
 * the chat stream's IPC event (replies reach the frame that sent the turn) or a send function.
 */
export function dispatchParsedPayload(
  target: Electron.IpcMainEvent | RendererSend,
  conversationId: string,
  parsed: ParsedAgentStreamPayload,
): void {
  const event = { reply: typeof target === 'function' ? target : replyTo(target) };
  if (parsed.type === 'status') {
    event.reply('message-status', conversationId, parsed.status);
  } else if (parsed.type === 'accept_command') {
    event.reply('message-accept-command', conversationId, parsed.acceptCommand);
  } else if (parsed.type === 'delete_confirm') {
    event.reply('message-delete-confirm', conversationId, parsed.deleteConfirm);
  } else if (parsed.type === 'background_command_open') {
    event.reply('message-background-command-open', conversationId, {
      commandId: parsed.commandId,
      commandText: parsed.commandText,
      cwdLabel: parsed.cwdLabel,
      label: parsed.label,
      streamTag: parsed.streamTag,
    });
  } else if (parsed.type === 'tool_read_chunk') {
    event.reply('message-tool-read-chunk', conversationId, parsed.delta, parsed.statusId);
  } else if (parsed.type === 'tool_exec_chunk') {
    event.reply('message-tool-exec-chunk', conversationId, parsed.delta, parsed.streamTag, parsed.label);
  } else if (parsed.type === 'tool_exec_complete') {
    event.reply(
      'message-tool-exec-complete',
      conversationId,
      parsed.streamTag,
      parsed.label,
      parsed.exitCode,
      parsed.outputExcerpt,
      parsed.outcome,
    );
  } else if (parsed.type === 'token_usage') {
    event.reply('message-token-usage', conversationId, {
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      totalTokens: parsed.totalTokens,
      generationMs: parsed.generationMs,
    });
  } else if (parsed.type === 'context_compressed') {
    event.reply('message-context-compressed', conversationId, {
      tokensBefore: parsed.tokensBefore,
      tokensAfter: parsed.tokensAfter,
      toolMessagesCompacted: parsed.toolMessagesCompacted,
      toolRoundsDropped: parsed.toolRoundsDropped,
    });
  } else if (parsed.type === 'chunk') {
    event.reply('message-chunk', conversationId, parsed.delta, parsed.streamTag);
  } else if (parsed.type === 'final_text') {
    event.reply('message-final-text', conversationId, parsed.text);
  } else if (parsed.type === 'clear_primary_stream') {
    event.reply('message-clear-primary-stream', conversationId);
  } else if (parsed.type === 'promote_primary_to_nudge') {
    event.reply('message-promote-primary-to-nudge', conversationId);
  } else if (parsed.type === 'planner_progress') {
    event.reply('message-planner-progress', conversationId, parsed.planner);
  } else if (parsed.type === 'build_plan_open') {
    event.reply('message-build-plan-open', conversationId, parsed.buildPlanOpen);
  } else if (parsed.type === 'build_plan_chunk') {
    event.reply('message-build-plan-chunk', conversationId, parsed.buildPlanChunk);
  } else if (parsed.type === 'build_plan_stream_end') {
    event.reply('message-build-plan-stream-end', conversationId, parsed.buildPlanStreamEnd);
  } else if (parsed.type === 'plan_confirm') {
    event.reply('message-plan-confirm', conversationId, parsed.planConfirm);
  } else if (parsed.type === 'agent_question') {
    event.reply('message-agent-question', conversationId, parsed.agentQuestion);
  } else if (parsed.type === 'theme_proposal') {
    event.reply('message-theme-proposal', conversationId, parsed.themeProposal);
  } else if (parsed.type === 'file_journal') {
    persistFileJournal(conversationId, parsed.fileJournal);
  }
  // `subagent_*` payloads are routed by the stream's sub-agent relay before they get here.
}

/** Map one SSE `data:` JSON payload to the renderer IPC channel(s) for this conversation. */
export function sendParsedPayload(event: Electron.IpcMainEvent, conversationId: string, payload: string): void {
  dispatchParsedPayload(event, conversationId, parseStreamPayload(payload));
}
