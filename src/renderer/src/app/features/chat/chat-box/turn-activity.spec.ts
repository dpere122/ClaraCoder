import type { StreamPart, TurnFeedItem } from '@shared/index';
import { toolTrailStatusStreamTag } from '@shared/index';
import { inFlightToolSpinnerKind, resolveTurnActivity, turnActivitySpinnerKind } from './chat-box-display';
import { toolGlyph, toolSpinnerKind } from './tool-spinner-kind';

describe('resolveTurnActivity', () => {
  const thought: TurnFeedItem = {
    kind: 'thought',
    part: { streamTag: 'reasoning', label: 'Model reasoning', text: 'hmm' },
  };
  const tool: TurnFeedItem = {
    kind: 'tool',
    part: { streamTag: toolTrailStatusStreamTag('run-1'), label: 'stage_create_file', text: 'src/a.ts' },
  };
  const prose: TurnFeedItem = { kind: 'markdown', text: 'Here is the answer.' };
  const base = { primaryLiveText: '', toolsActive: false, toolKind: null, awaitingReview: false };

  it('is prefill before the first stream item', () => {
    expect(resolveTurnActivity({ ...base, feed: [] })).toBe('prefill');
  });

  it('is think while reasoning is the latest event and no tool runs', () => {
    expect(resolveTurnActivity({ ...base, feed: [thought] })).toBe('think');
  });

  it('picks the running tool kind while tools are active', () => {
    expect(resolveTurnActivity({ ...base, feed: [thought, tool], toolsActive: true })).toBe('write');
    for (const toolKind of ['read', 'write', 'run', 'web'] as const) {
      expect(resolveTurnActivity({ ...base, feed: [thought, tool], toolsActive: true, toolKind })).toBe(toolKind);
    }
  });

  it('is reply while prose streams, even with a tool still marked active', () => {
    expect(resolveTurnActivity({ ...base, feed: [tool, prose] })).toBe('reply');
    expect(resolveTurnActivity({ ...base, feed: [thought], primaryLiveText: 'partial', toolsActive: true })).toBe(
      'reply',
    );
  });

  it('is review whenever a HITL card blocks the turn', () => {
    expect(resolveTurnActivity({ ...base, feed: [], awaitingReview: true })).toBe('review');
    expect(resolveTurnActivity({ ...base, feed: [tool], toolsActive: true, awaitingReview: true })).toBe('review');
  });
});

describe('inFlightToolSpinnerKind', () => {
  const running = (label: string): StreamPart => ({
    streamTag: toolTrailStatusStreamTag(label),
    label,
    text: '',
    toolChainState: 'running',
  });

  it('follows the latest running tool', () => {
    expect(inFlightToolSpinnerKind([running('stage_create_file'), running('read_workspace_file')], true)).toBe('read');
    expect(inFlightToolSpinnerKind([running('read_workspace_file'), running('stage_create_file')], true)).toBe('write');
    expect(inFlightToolSpinnerKind([running('read_workspace_file'), running('run_command')], true)).toBe('run');
    expect(inFlightToolSpinnerKind([running('fetch_url')], true)).toBe('web');
  });

  it('is null when tools are not active', () => {
    expect(inFlightToolSpinnerKind([running('read_workspace_file')], false)).toBeNull();
  });
});

describe('toolSpinnerKind', () => {
  it('classifies tools by name and stream tag', () => {
    expect(toolSpinnerKind('search_workspace', '')).toBe('read');
    expect(toolSpinnerKind('wait_for_command', '')).toBe('run');
    expect(toolSpinnerKind('anything', 'run-command:abc')).toBe('run');
    expect(toolSpinnerKind('web_search', '')).toBe('web');
    expect(toolSpinnerKind('fetch_url', '')).toBe('web');
    expect(toolSpinnerKind('replace_workspace_snippet', '')).toBe('write');
  });
});

describe('toolGlyph', () => {
  it('gives every agent tool its own glyph', () => {
    const tools = [
      'read_workspace_file',
      'read_workspace_image',
      'list_workspace_directory',
      'search_workspace',
      'retrieve_workspace_semantic',
      'structured_overview',
      'search_structured',
      'read_structured_section',
      'activate_context',
      'lsp_get_diagnostics',
      'lsp_hover',
      'lsp_find_definition',
      'lsp_find_references',
      'lsp_get_document_symbols',
      'write_workspace_file',
      'replace_workspace_lines',
      'replace_workspace_snippet',
      'format_workspace_file',
      'copy_workspace_files',
      'delete_workspace_entries',
      'java_bootstrap_project',
      'web_search',
      'fetch_url',
      'run_command',
      'wait_for_command',
      'kill_background_command',
      'list_background_commands',
      'check_user_terminals',
      'read_build_plan',
      'mark_build_plan_steps_complete',
      'spawn_subagent',
      'wait_for_subagents',
      'stop_subagent',
      'propose_theme',
    ];
    const glyphs = tools.map((name) => toolGlyph(name, ''));
    expect(glyphs).not.toContain('plug');
    expect(new Set(glyphs).size).toBe(tools.length);
  });

  it('matches tool families by prefix and language-routed LSP writes', () => {
    expect(toolGlyph('xml_overview', '')).toBe('xml');
    expect(toolGlyph('json_get_path', '')).toBe('json');
    expect(toolGlyph('wsdl_list_operations', '')).toBe('wsdl');
    expect(toolGlyph('lsp_update_typescript_file', '')).toBe('write-file');
  });

  it('falls back on the stream tag, then the plug', () => {
    expect(toolGlyph('npm test', 'run-command:abc')).toBe('command');
    expect(toolGlyph('mcp__blender__get_objects_summary', '')).toBe('plug');
    expect(toolGlyph('', '')).toBe('plug');
  });
});

describe('turnActivitySpinnerKind', () => {
  it('maps each spinning activity to its spinner, and shows none while replying or awaiting review', () => {
    for (const kind of ['prefill', 'think', 'read', 'write', 'run', 'web'] as const) {
      expect(turnActivitySpinnerKind(kind)).toBe(kind);
    }
    expect(turnActivitySpinnerKind('reply')).toBeNull();
    expect(turnActivitySpinnerKind('review')).toBeNull();
  });
});
