/**
 * Payload for SSE `theme_proposal`: an agent-authored theme document the user can preview,
 * save, or dismiss from a chat card. Emitted by the Python `propose_theme` tool; never pauses
 * the agent, and the card's actions resolve locally through Electron (no Python round-trip).
 */
import type { ClaraThemeDocument } from '../theme/theme-document';

export interface ThemeProposalPayload {
  version: 1;
  requestId: string;
  title: string;
  /** One or two sentences from the agent describing the look. */
  summary: string;
  /** Raw document as proposed; the renderer re-validates before preview / save. */
  theme: ClaraThemeDocument;
  /** Normalization notes from the backend validator (dropped tokens, etc.). */
  warnings?: string[];
}

export type ThemeProposalAction = 'saved' | 'applied' | 'dismissed';

export interface ThemeProposalFinishedEvent {
  requestId: string;
  status: 'complete' | 'cancelled';
  summary: string;
  /** Id of the saved theme (when `status === 'complete'`). */
  savedThemeId?: string;
}

/** Minimal structural gate used by the renderer before appending the artifact. */
export function isThemeProposalPayload(value: unknown): value is ThemeProposalPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Partial<ThemeProposalPayload>;
  return (
    v.version === 1 &&
    typeof v.requestId === 'string' &&
    v.requestId.length > 0 &&
    typeof v.title === 'string' &&
    !!v.theme &&
    typeof v.theme === 'object'
  );
}
