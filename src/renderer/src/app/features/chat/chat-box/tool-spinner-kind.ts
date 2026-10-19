import {
  isReadToolPreviewStreamTag,
  isRunCommandStreamTag,
  isShellStyleToolStreamTag,
  isWorkspaceReadToolLabel,
} from '@shared/index';

/**
 * Which tool spinner a running tool shows: `read` (book highlighter), `run` (terminal),
 * `web` (globe) or `write` (jot pen — every other tool).
 */
export type ToolSpinnerKind = 'read' | 'write' | 'run' | 'web';

/** Shell / background-command tools (terminal spinner). */
const RUN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'run_command',
  'wait_for_command',
  'list_background_commands',
  'kill_background_command',
]);

/** Network tools (globe spinner). */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set<string>(['web_search', 'fetch_url']);

export function toolSpinnerKind(label: string, streamTag: string): ToolSpinnerKind {
  const name = label.trim();
  if (isWorkspaceReadToolLabel(name) || isReadToolPreviewStreamTag(streamTag)) {
    return 'read';
  }
  if (WEB_TOOL_NAMES.has(name)) {
    return 'web';
  }
  if (RUN_TOOL_NAMES.has(name) || isRunCommandStreamTag(streamTag) || isShellStyleToolStreamTag(streamTag)) {
    return 'run';
  }
  return 'write';
}

/** Spinner image for a tool kind. */
export function toolSpinnerSrc(kind: ToolSpinnerKind): string {
  switch (kind) {
    case 'read':
      return 'spinner-read.svg';
    case 'run':
      return 'spinner-run.svg';
    case 'web':
      return 'spinner-web.svg';
    default:
      return 'spinner-jot.svg';
  }
}
