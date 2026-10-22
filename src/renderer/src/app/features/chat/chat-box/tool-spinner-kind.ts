import {
  isReadToolPreviewStreamTag,
  isRunCommandStreamTag,
  isShellStyleToolStreamTag,
  isWorkspaceReadToolLabel,
} from '@shared/index';

/**
 * Which tool spinner a running tool shows: `read` (nested squares), `run` (hex core),
 * `web` (branching signal) or `write` (fractal tree — every other tool).
 */
export type ToolSpinnerKind = 'read' | 'write' | 'run' | 'web';

/** Spinner a live pill can host: a tool kind, or `think` for the compact thinking pill. */
export type PillSpinnerKind = ToolSpinnerKind | 'think';

/** Every spinner {@link ToolSpinnerComponent} draws: pill kinds plus `prefill` (reading the prompt). */
export type SpinnerKind = PillSpinnerKind | 'prefill';

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
