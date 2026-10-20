import type { StreamPart } from './types/conversation';
import {
  isHitlTrailStreamTag,
  isRunCommandStreamTag,
  isToolTrailStatusStreamTag,
  READ_TOOL_PREVIEW_STREAM_TAG,
  RUN_COMMAND_STREAM_TAG_PREFIX,
  TOOL_NODE_SMOKE_STREAM_TAG,
  TOOL_OVERLAY_STREAM_TAG,
  TOOL_PYTEST_STREAM_TAG,
  TOOL_SMOKE_STREAM_TAG,
} from './stream-parts';
import { condenseToolTrailText, readToolStatusHeadline, READ_TOOL_STREAM_BODY_MARKER } from './tool-trail-pill';

/** Tool families that share a verb and collapse together when called back to back. */
export type ToolPillCategory = 'read' | 'search' | 'list' | 'edit' | 'run' | 'lsp' | 'web' | 'other';

/** Human pill text for one tool row: `Read · src/app.ts · 42 lines`. */
export interface ToolPillLabel {
  category: ToolPillCategory;
  /** Short action shown as the pill name (`Read`, `Edit`, `Run`). */
  verb: string;
  /** What the tool acted on: path, query or command. */
  target: string;
  /** Short outcome: line counts, exit code, match count, error. */
  detail: string;
}

type ToolSpec = { verb: string; category: ToolPillCategory };

const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = {
  read_workspace_file: { verb: 'Read', category: 'read' },
  read_staged_edit: { verb: 'Read staged', category: 'read' },
  read_structured_section: { verb: 'Read', category: 'read' },
  read_workspace_image: { verb: 'View image', category: 'read' },
  read_build_plan: { verb: 'Read plan', category: 'other' },
  list_workspace_directory: { verb: 'List', category: 'list' },
  structured_overview: { verb: 'Outline', category: 'list' },
  xml_overview: { verb: 'Outline', category: 'list' },
  search_workspace: { verb: 'Search', category: 'search' },
  search_structured: { verb: 'Search', category: 'search' },
  retrieve_workspace_semantic: { verb: 'Semantic search', category: 'search' },
  web_search: { verb: 'Web search', category: 'web' },
  fetch_url: { verb: 'Fetch', category: 'web' },
  write_workspace_file: { verb: 'Write', category: 'edit' },
  replace_workspace_lines: { verb: 'Edit', category: 'edit' },
  replace_workspace_line_range: { verb: 'Edit', category: 'edit' },
  replace_workspace_snippet: { verb: 'Edit', category: 'edit' },
  apply_workspace_full_file: { verb: 'Write', category: 'edit' },
  format_workspace_file: { verb: 'Format', category: 'edit' },
  stage_create_file: { verb: 'Stage', category: 'edit' },
  stage_line_range_edit: { verb: 'Stage', category: 'edit' },
  stage_snippet_edit: { verb: 'Stage', category: 'edit' },
  stage_workspace_file_overwrite: { verb: 'Stage', category: 'edit' },
  transfer_staged_file_to_workspace: { verb: 'Keep staged', category: 'other' },
  discard_staged_edits: { verb: 'Discard staged', category: 'other' },
  list_staged_edits: { verb: 'Staged edits', category: 'other' },
  diff_staged_edit_against_baseline: { verb: 'Diff', category: 'other' },
  delete_workspace_entry: { verb: 'Delete', category: 'other' },
  delete_workspace_entries: { verb: 'Delete', category: 'other' },
  batch_delete_workspace_entries: { verb: 'Delete', category: 'other' },
  copy_workspace_files: { verb: 'Copy', category: 'other' },
  run_command: { verb: 'Run', category: 'run' },
  wait_for_command: { verb: 'Wait', category: 'run' },
  kill_background_command: { verb: 'Stop command', category: 'run' },
  list_background_commands: { verb: 'Commands', category: 'run' },
  check_user_terminals: { verb: 'Check terminals', category: 'run' },
  lsp_get_diagnostics: { verb: 'Diagnostics', category: 'lsp' },
  lsp_hover: { verb: 'Hover', category: 'lsp' },
  lsp_find_definition: { verb: 'Definition', category: 'lsp' },
  lsp_find_references: { verb: 'References', category: 'lsp' },
  lsp_get_document_symbols: { verb: 'Symbols', category: 'lsp' },
  propose_theme: { verb: 'Propose theme', category: 'other' },
  mark_build_plan_steps_complete: { verb: 'Plan progress', category: 'other' },
  java_bootstrap_project: { verb: 'Bootstrap Java', category: 'other' },
  activate_context: { verb: 'Load context', category: 'other' },
};

/** `lsp_update_typescript_file` / `lsp_create_java_file`: language-routed full-file writes. */
const LSP_WRITE_TOOL = /^lsp_(?:update|create)_[a-z]+_file$/;

/** `mcp__<server>__get_addon_status` → `get_addon_status`. */
function stripMcpPrefix(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

/** `get_addon_status` → `Get addon status`; labels that already read as prose pass through. */
export function humanizeToolName(name: string): string {
  const raw = stripMcpPrefix(name.trim());
  if (!raw || /\s/.test(raw) || !raw.includes('_')) {
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Tool';
  }
  const words = raw.split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toolSpec(name: string): ToolSpec {
  const n = name.trim();
  const spec = TOOL_SPECS[n];
  if (spec) {
    return spec;
  }
  if (LSP_WRITE_TOOL.test(n)) {
    return { verb: 'Write', category: 'edit' };
  }
  return { verb: humanizeToolName(n), category: 'other' };
}

/** Pill verb for a tool name (`read_workspace_file` → `Read`). */
export function toolPillVerb(name: string): string {
  return toolSpec(name).verb;
}

const DRAFTING_SUFFIX = /(?:^|\s·\s)drafting \d+(?:\.\d+)? (?:chars|KB)\s*$/;

/**
 * Target (path / query / command) from a running tool status detail. The backend sends the
 * call's path or query while the tool runs and replaces it with the result on completion, so
 * the first one is kept on the part. Native previews append ` · drafting 1.2 KB` while the
 * arguments stream; that suffix is not part of the target.
 */
export function toolTargetFromRunningDetail(detail: string): string {
  return detail.replace(DRAFTING_SUFFIX, '').trim();
}

/** Command id from a `run_command` report (`- Command id: \`6514a07e\``). */
export function runCommandIdFromReport(text: string): string | null {
  const m = /Command id: `([^`]+)`/.exec(text);
  return m ? m[1]! : null;
}

function firstBacktickPath(text: string): string {
  const m = /`([^`\n]+)`/.exec(text);
  return m ? m[1]!.trim() : '';
}

/** Path or subject the completed result names, for rows saved before targets were kept. */
function targetFromResult(name: string, category: ToolPillCategory, text: string): string {
  const head = readToolStatusHeadline(text);
  const fileHead = /^(?:Staged file|File|Directory|XML): (\S+)/.exec(head);
  if (fileHead) {
    return fileHead[1]!;
  }
  const image = /^Loaded image: (.+?) Type:/.exec(head);
  if (image) {
    return image[1]!.trim();
  }
  if (name === 'run_command' || name === 'wait_for_command' || name === 'kill_background_command') {
    // The status line is truncated, so a long command may lose its closing backtick.
    const cmd = /Command: `([^`]+?)(?:`|…?$)/.exec(text);
    return cmd ? cmd[1]!.trim() : '';
  }
  const quoted = /^(?:Proposed theme|Build plan) "(.+?)"(?: \(| ready)/.exec(text);
  if (quoted) {
    return quoted[1]!;
  }
  const planTitle = /^# Build Plan: (.+?)(?:\s+##|$)/.exec(text);
  if (planTitle) {
    return planTitle[1]!.trim();
  }
  if (name.startsWith('delete_') && (text.match(/Deleted (?:file|directory) `/g)?.length ?? 0) === 1) {
    return firstBacktickPath(text);
  }
  if (name === 'transfer_staged_file_to_workspace') {
    const paths = /^Staged \d+ path\(s\) \((.+?)\) ready/.exec(text);
    return paths ? paths[1]!.replace(/`/g, '') : '';
  }
  if (category === 'edit' || category === 'lsp') {
    return firstBacktickPath(text);
  }
  if (name === 'diff_staged_edit_against_baseline' || name === 'discard_staged_edits') {
    return firstBacktickPath(text);
  }
  return '';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function readDetail(text: string): string {
  const head = readToolStatusHeadline(text);
  const lines = /Lines: (\d+)-(\d+)(?: \(of (\d+) in file\))?/.exec(head);
  if (lines) {
    const [, a, b, total] = lines;
    if (a === '1' && total && b === total) {
      return plural(Number(total), 'line');
    }
    return `lines ${a}–${b}`;
  }
  const size = /Size: (\d+)x(\d+) px/.exec(head);
  if (size) {
    return `${size[1]}×${size[2]}`;
  }
  return '';
}

function searchDetail(text: string): string {
  const marker = text.indexOf(READ_TOOL_STREAM_BODY_MARKER);
  const body = marker >= 0 ? text.slice(marker) : text;
  const hits = body.match(/\[[^\]\n]+ line \d+\]/g)?.length ?? 0;
  if (hits > 0) {
    return plural(hits, 'match', 'matches');
  }
  const chunks = body.match(/--- \d+\. file=/g)?.length ?? 0;
  if (chunks > 0) {
    return plural(chunks, 'chunk');
  }
  if (/no (?:matches|results)/i.test(body)) {
    return 'no matches';
  }
  return '';
}

function listDetail(text: string): string {
  const head = readToolStatusHeadline(text);
  if (/\[empty\]/.test(head)) {
    return 'empty';
  }
  return '';
}

function editDetail(text: string): string {
  const lines = /\((?:[a-z-]+; )?(\d+) → (\d+) lines\)/.exec(text);
  if (lines) {
    return `${lines[1]} → ${lines[2]} lines`;
  }
  if (/^Staged `|^Updated staged draft `/.test(text)) {
    return 'staged';
  }
  return '';
}

function runDetail(text: string): string {
  const terminals = /^User PTY terminals \((\d+)\)/.exec(text);
  if (terminals) {
    return plural(Number(terminals[1]), 'terminal');
  }
  if (/^No active user PTY terminals/.test(text)) {
    return 'none open';
  }
  if (!/^Command report:/.test(text)) {
    return '';
  }
  const exit = /Status: exited with code (-?\d+)/.exec(text);
  if (exit) {
    return `exit ${exit[1]}`;
  }
  return /Status: running/.test(text) ? 'running' : '';
}

function lspDetail(text: string): string {
  const issues = /\((\d+) issue\(s\)\)/.exec(text);
  if (issues) {
    return plural(Number(issues[1]), 'issue');
  }
  if (/No LSP diagnostics/.test(text)) {
    return 'no issues';
  }
  return '';
}

function deleteDetail(text: string): string {
  const deleted = text.match(/Deleted (?:file|directory) `/g)?.length ?? 0;
  return deleted > 1 ? plural(deleted, 'entry', 'entries') : '';
}

function completedDetail(name: string, category: ToolPillCategory, text: string): string {
  if (/^Pending user confirmation/.test(text)) {
    return 'awaiting approval';
  }
  if (name === 'mark_build_plan_steps_complete') {
    const done = /^Marked complete: ([^.]+)\./.exec(text);
    return done ? plural(done[1]!.split(',').length, 'step') : '';
  }
  if (name === 'transfer_staged_file_to_workspace' && /human confirmation/.test(text)) {
    return 'awaiting approval';
  }
  switch (category) {
    case 'read':
      return readDetail(text);
    case 'search':
      return searchDetail(text);
    case 'list':
      return listDetail(text);
    case 'edit':
      return editDetail(text);
    case 'run':
      return runDetail(text);
    case 'lsp':
      return lspDetail(text);
    default:
      return name.startsWith('delete_') || name === 'batch_delete_workspace_entries' ? deleteDetail(text) : '';
  }
}

/** Display name for a delegated subprocess lane (`run-command:*`, pytest, smoke). */
function delegatedLaneVerb(streamTag: string): string | null {
  const tag = streamTag.trim();
  if (isRunCommandStreamTag(tag)) {
    return 'Run';
  }
  switch (tag) {
    case TOOL_PYTEST_STREAM_TAG:
      return 'Tests';
    case TOOL_SMOKE_STREAM_TAG:
    case TOOL_NODE_SMOKE_STREAM_TAG:
      return 'Smoke test';
    case TOOL_OVERLAY_STREAM_TAG:
      return 'Review';
    case READ_TOOL_PREVIEW_STREAM_TAG:
      return 'Read';
    default:
      return null;
  }
}

function delegatedLaneDetail(part: StreamPart, live: boolean): string {
  if (part.runComplete === false && live) {
    return 'running';
  }
  if (part.outcome) {
    return part.outcome;
  }
  if (part.exitCode != null) {
    return `exit ${part.exitCode}`;
  }
  return condenseToolTrailText(part.text.split(/\r?\n/).filter((l) => l.trim()).pop() ?? '', 40);
}

/**
 * Human label for a tool row in the turn feed. Tool-trail status rows map their tool name to a
 * verb and pull the target and a short outcome out of the result text; subprocess lanes
 * (`run-command:*`, pytest, smoke) use the command as the target and the exit code as detail.
 */
export function toolPillLabel(part: StreamPart, live = false): ToolPillLabel {
  if (!isToolTrailStatusStreamTag(part.streamTag) && !isHitlTrailStreamTag(part.streamTag)) {
    const verb = delegatedLaneVerb(part.streamTag);
    if (verb) {
      const category: ToolPillCategory = isRunCommandStreamTag(part.streamTag) ? 'run' : 'other';
      return { category, verb, target: part.label.trim(), detail: delegatedLaneDetail(part, live) };
    }
    return { category: 'other', verb: humanizeToolName(part.label || 'Tool'), target: '', detail: '' };
  }

  const name = part.label.trim();
  const { verb, category } = toolSpec(name);
  const text = part.text.trim();
  const state = part.toolChainState;
  const target = (part.toolTarget ?? '').trim() || (state === 'running' ? '' : targetFromResult(name, category, text));

  if (state === 'running') {
    return { category, verb, target: target || toolTargetFromRunningDetail(text), detail: '' };
  }
  if (state === 'error' || /^Tool error:/.test(text)) {
    const message = text.replace(/^Tool error:\s*/, '');
    return { category, verb, target, detail: condenseToolTrailText(message, 48) || 'error' };
  }
  const created = /^Created `[^`]+` \([^;)]*;? ?0 → (\d+) lines\)/.exec(text);
  if (created) {
    return { category, verb: 'Create', target, detail: plural(Number(created[1]), 'line') };
  }
  let detail = completedDetail(name, category, text);
  if (!target && !detail) {
    // Unknown result shape: a short excerpt beats an empty pill.
    detail = condenseToolTrailText(readToolStatusHeadline(text), 48);
  }
  return { category, verb, target, detail };
}

/** Pill meta line: `target · detail` (either may be empty). */
export function toolPillMeta(label: Pick<ToolPillLabel, 'target' | 'detail'>): string {
  return [label.target, label.detail].filter((s) => s.length > 0).join(' · ');
}

/** True for the `run-command:<id>` lane that carries the output of a `run_command` call. */
export function runCommandLaneId(streamTag: string): string | null {
  const tag = streamTag.trim();
  return tag.startsWith(RUN_COMMAND_STREAM_TAG_PREFIX) ? tag.slice(RUN_COMMAND_STREAM_TAG_PREFIX.length) : null;
}

const GROUP_NOUNS: Readonly<Record<ToolPillCategory, [string, string]>> = {
  read: ['file', 'files'],
  search: ['search', 'searches'],
  list: ['folder', 'folders'],
  edit: ['edit', 'edits'],
  run: ['command', 'commands'],
  lsp: ['check', 'checks'],
  web: ['request', 'requests'],
  other: ['call', 'calls'],
};

const GROUP_VERBS: Readonly<Record<Exclude<ToolPillCategory, 'other'>, string>> = {
  read: 'Read',
  search: 'Search',
  list: 'List',
  edit: 'Edit',
  run: 'Run',
  lsp: 'LSP',
  web: 'Web',
};

/** Last path segment for compact group summaries (`src/app/main.ts` → `main.ts`). */
function shortTarget(target: string): string {
  if (!/[\\/]/.test(target) || /\s/.test(target)) {
    return target;
  }
  const seg = target.split(/[\\/]/).filter(Boolean).pop();
  return seg ?? target;
}

/** True when two tool rows collapse into one group pill when adjacent. */
export function toolPillsGroupTogether(a: ToolPillLabel, b: ToolPillLabel): boolean {
  if (a.category !== b.category) {
    return false;
  }
  return a.category !== 'other' || a.verb === b.verb;
}

/** Group pill text for consecutive same-kind tool rows: `Read · 3 files · a.ts, b.ts`. */
export function toolPillGroupLabel(labels: readonly ToolPillLabel[]): { verb: string; meta: string } {
  const first = labels[0];
  if (!first) {
    return { verb: 'Tools', meta: '' };
  }
  const verb = first.category === 'other' ? first.verb : GROUP_VERBS[first.category];
  const [one, many] = GROUP_NOUNS[first.category];
  const targets = [...new Set(labels.map((l) => shortTarget(l.target)).filter((t) => t.length > 0))];
  return { verb, meta: [plural(labels.length, one, many), targets.join(', ')].filter(Boolean).join(' · ') };
}
