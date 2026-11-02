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

/**
 * Prompt-prefill spinners: `prefill` (a drop absorbed into a pool) plus the alternates a turn can
 * pick while it reads the prompt — a sheet unfolding, a cipher dial, two waves falling into phase.
 */
export type PrefillSpinnerKind = 'prefill' | 'prefill-unfold' | 'prefill-decipher' | 'prefill-attune';

/** Every spinner {@link ToolSpinnerComponent} draws: pill kinds plus the prefill set. */
export type SpinnerKind = PillSpinnerKind | PrefillSpinnerKind;

/** Shell / background-command tools (terminal spinner). */
const RUN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'run_command',
  'wait_for_command',
  'list_background_commands',
  'kill_background_command',
]);

/** Network tools (globe spinner). */
const WEB_TOOL_NAMES: ReadonlySet<string> = new Set<string>(['web_search', 'fetch_url', 'screenshot_webpage']);

/**
 * One glyph per agent tool: drawn still it is the tool's icon, animated it is that tool's spinner.
 * Names never collide with {@link SpinnerKind}, so {@link ToolSpinnerComponent} takes either.
 */
export const TOOL_GLYPH_IDS = [
  'read-file',
  'image',
  'list',
  'search',
  'semantic',
  'outline',
  'tree-search',
  'section',
  'xml',
  'json',
  'wsdl',
  'context',
  'diagnostics',
  'hover',
  'definition',
  'references',
  'symbols',
  'write-file',
  'edit-lines',
  'edit-snippet',
  'format',
  'copy',
  'delete',
  'java',
  'web-search',
  'fetch',
  'screenshot',
  'command',
  'wait',
  'stop-command',
  'commands',
  'terminals',
  'plan',
  'plan-check',
  'spawn',
  'agents',
  'stop-agent',
  'theme',
  'plug',
] as const;

export type ToolGlyph = (typeof TOOL_GLYPH_IDS)[number];

/** Spinner a live pill can host: a tool's glyph, or `think` for the compact thinking pill. */
export type PillGlyph = ToolGlyph | 'think';

const TOOL_GLYPHS: Readonly<Record<string, ToolGlyph>> = {
  read_workspace_file: 'read-file',
  read_staged_edit: 'read-file',
  read_workspace_image: 'image',
  list_workspace_directory: 'list',
  search_workspace: 'search',
  retrieve_workspace_semantic: 'semantic',
  structured_overview: 'outline',
  search_structured: 'tree-search',
  read_structured_section: 'section',
  activate_context: 'context',
  lsp_get_diagnostics: 'diagnostics',
  lsp_hover: 'hover',
  lsp_find_definition: 'definition',
  lsp_find_references: 'references',
  lsp_get_document_symbols: 'symbols',
  write_workspace_file: 'write-file',
  apply_workspace_full_file: 'write-file',
  stage_create_file: 'write-file',
  stage_workspace_file_overwrite: 'write-file',
  transfer_staged_file_to_workspace: 'write-file',
  replace_workspace_lines: 'edit-lines',
  replace_workspace_line_range: 'edit-lines',
  stage_line_range_edit: 'edit-lines',
  replace_workspace_snippet: 'edit-snippet',
  stage_snippet_edit: 'edit-snippet',
  format_workspace_file: 'format',
  copy_workspace_files: 'copy',
  delete_workspace_entry: 'delete',
  delete_workspace_entries: 'delete',
  batch_delete_workspace_entries: 'delete',
  discard_staged_edits: 'delete',
  java_bootstrap_project: 'java',
  web_search: 'web-search',
  fetch_url: 'fetch',
  screenshot_webpage: 'screenshot',
  run_command: 'command',
  wait_for_command: 'wait',
  kill_background_command: 'stop-command',
  list_background_commands: 'commands',
  check_user_terminals: 'terminals',
  read_build_plan: 'plan',
  mark_build_plan_steps_complete: 'plan-check',
  spawn_subagent: 'spawn',
  wait_for_subagents: 'agents',
  stop_subagent: 'stop-agent',
  propose_theme: 'theme',
};

/** Tool families matched by name prefix (`xml_overview`, `json_get_path`, …). */
const TOOL_GLYPH_PREFIXES: readonly (readonly [string, ToolGlyph])[] = [
  ['xml_', 'xml'],
  ['json_', 'json'],
  ['wsdl_', 'wsdl'],
];

/** `lsp_update_typescript_file` / `lsp_create_java_file`: language-routed full-file writes. */
const LSP_WRITE_TOOL = /^lsp_(?:update|create)_[a-z]+_file$/;

/** The glyph for one tool row; unknown and MCP tools get the plug. */
export function toolGlyph(label: string, streamTag: string): ToolGlyph {
  const name = label.trim();
  const named = TOOL_GLYPHS[name];
  if (named) {
    return named;
  }
  if (LSP_WRITE_TOOL.test(name)) {
    return 'write-file';
  }
  for (const [prefix, glyph] of TOOL_GLYPH_PREFIXES) {
    if (name.startsWith(prefix)) {
      return glyph;
    }
  }
  if (isReadToolPreviewStreamTag(streamTag)) {
    return 'read-file';
  }
  if (isRunCommandStreamTag(streamTag) || isShellStyleToolStreamTag(streamTag)) {
    return 'command';
  }
  return 'plug';
}

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
