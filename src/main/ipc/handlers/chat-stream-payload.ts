import { parseAgentStreamPayload } from '../../../shared';

export const parseStreamPayload = parseAgentStreamPayload;

/** Map one SSE `data:` JSON payload to the renderer IPC channel(s) for this conversation. */
export function sendParsedPayload(event: Electron.IpcMainEvent, conversationId: string, payload: string): void {
  const parsed = parseStreamPayload(payload);
  if (parsed.type === 'status') {
    event.reply('message-status', conversationId, parsed.status);
  } else if (parsed.type === 'diff') {
    event.reply('message-diff', conversationId, parsed.diff);
  } else if (parsed.type === 'accept_command') {
    event.reply('message-accept-command', conversationId, parsed.acceptCommand);
  } else if (parsed.type === 'copy_confirm') {
    event.reply('message-copy-confirm', conversationId, parsed.copyConfirm);
  } else if (parsed.type === 'delete_confirm') {
    event.reply('message-delete-confirm', conversationId, parsed.deleteConfirm);
  } else if (parsed.type === 'tool_read_chunk') {
    event.reply('message-tool-read-chunk', conversationId, parsed.delta);
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
    });
  } else if (parsed.type === 'chunk') {
    event.reply('message-chunk', conversationId, parsed.delta, parsed.streamTag);
  } else if (parsed.type === 'harness_crystal') {
    event.reply('message-harness-crystal', conversationId, parsed.polarity);
  } else if (parsed.type === 'final_text') {
    event.reply('message-final-text', conversationId, parsed.text);
  }
}
