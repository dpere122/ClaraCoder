import type { ConversationFile, TurnEndedEarly } from '../shared';

/** One `/load` history row (Python `routes/session.py` `_load_message_content`). */
export type PythonHistoryMessage =
  | { role: 'user'; message: string; structuredContent?: readonly Record<string, unknown>[] }
  | { role: 'assistant'; content: string };

/** Mirrors the marker Python's composer commits to session history for a turn that did not finish. */
const ENDED_EARLY_MARKER: Readonly<Record<TurnEndedEarly, string>> = {
  stopped: '[Interrupted by the user]',
  interrupted: '[Interrupted by the user]',
  error: '[This reply failed before it finished]',
};

/** Assistant text for the model: a partial reply says so, so the agent does not take it as complete. */
function assistantHistoryContent(text: string, endedEarly: TurnEndedEarly | undefined): string {
  if (!endedEarly) {
    return text;
  }
  const marker = ENDED_EARLY_MARKER[endedEarly];
  return text.trim() ? `${text}\n\n${marker}` : marker;
}

/** User/assistant rows of a saved transcript in the shape Python `/load` takes. */
export function pythonHistoryFromMessages(messages: ConversationFile['messages']): PythonHistoryMessage[] {
  const out: PythonHistoryMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        message: m.text,
        ...(m.structuredContent?.length ? { structuredContent: m.structuredContent } : {}),
      });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: assistantHistoryContent(m.text, m.endedEarly) });
    }
  }
  return out;
}
