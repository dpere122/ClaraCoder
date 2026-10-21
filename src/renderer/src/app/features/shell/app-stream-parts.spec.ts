import { describe, expect, it } from 'vitest';
import type { LlmStatus } from '../../../../../shared/types/llm';
import type { StreamPart } from '../../../../../shared/types/conversation';
import { buildTurnFeed, clearPrimaryStreamParts, toolTrailStatusStreamTag } from '../../../../../shared/stream-parts';
import { mergeToolTrailStatusText, upsertClaraOuterBriefStreamPart, upsertToolTrailStatusStreamPart, appendStreamPart } from './app-stream-parts';

describe('mergeToolTrailStatusText', () => {
  it('preserves streamed read body when status detail is a one-liner', () => {
    const prev = {
      streamTag: toolTrailStatusStreamTag('r1'),
      label: 'read_workspace_file',
      text: 'src/a.py\n\n── read_workspace_file ──\n  1 │ line\n',
    };
    const incoming = { label: 'read_workspace_file', text: 'ok (120 chars)' };
    expect(mergeToolTrailStatusText(prev, incoming)).toBe(
      'ok (120 chars)\n\n── read_workspace_file ──\n  1 │ line\n',
    );
  });

  it('replaces text when there is no streamed read preview yet', () => {
    const prev = {
      streamTag: toolTrailStatusStreamTag('r1'),
      label: 'read_workspace_file',
      text: 'src/a.py',
    };
    expect(mergeToolTrailStatusText(prev, { label: 'read_workspace_file', text: 'done' })).toBe('done');
  });
});

describe('upsertToolTrailStatusStreamPart', () => {
  it('does not wipe read preview on tool complete', () => {
    const trailTag = toolTrailStatusStreamTag('run-1');
    const parts = [
      {
        streamTag: trailTag,
        label: 'read_workspace_file',
        text: 'src/foo.py\n\n── read_workspace_file ──\n  1 │ x\n',
        toolChainState: 'running' as const,
      },
    ];
    const status: LlmStatus = {
      id: 'run-1',
      label: 'read_workspace_file',
      detail: 'ok (42 chars)',
      state: 'complete',
      source: 'tool',
    };
    const out = upsertToolTrailStatusStreamPart(parts, status);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('── read_workspace_file ──');
    expect(out[0].text).toContain('  1 │ x');
    expect(out[0].text.startsWith('ok (42 chars)')).toBe(true);
    expect(out[0].toolChainState).toBe('complete');
  });

  it('an answered approval card replaces the pending row and brings its run time', () => {
    const fetch = (detail: string, durationMs?: number): LlmStatus => ({
      id: 'f1',
      label: 'fetch_url',
      detail,
      state: 'complete',
      source: 'tool',
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    const pending = upsertToolTrailStatusStreamPart([], fetch('Pending user confirmation for `fetch_url`.'));
    expect(pending[0].toolDurationMs).toBeUndefined();
    const answered = upsertToolTrailStatusStreamPart(pending, fetch('URL: https://example.com Status: 200', 31));
    expect(answered).toHaveLength(1);
    expect(answered[0].text).toBe('URL: https://example.com Status: 200');
    expect(answered[0].toolDurationMs).toBe(31);
  });

  it('a new tool row ends the thought before it', () => {
    const parts = appendStreamPart([], 'reasoning', 'look at the file', '', 2_000);
    const status: LlmStatus = { id: 'r1', label: 'read_workspace_file', detail: 'a.py', state: 'running', source: 'tool' };
    const out = upsertToolTrailStatusStreamPart(parts, status, 9_000);
    expect(out[0]).toMatchObject({ thoughtStartedAt: 2_000, thoughtDurationMs: 7_000 });
  });

  it('keeps the sub-agent a spawn pill runs from its running status through its result', () => {
    const spawn = (state: LlmStatus['state'], detail: string, withLink: boolean): LlmStatus => ({
      id: 's1',
      label: 'spawn_subagent',
      detail,
      state,
      source: 'tool',
      ...(withLink ? { subagent: { conversationId: 'child-1', name: 'Reader' } } : {}),
    });
    const running = upsertToolTrailStatusStreamPart([], spawn('running', 'Reader', true));
    expect(running[0]).toMatchObject({ toolSubagentId: 'child-1', toolSubagentName: 'Reader' });
    const done = upsertToolTrailStatusStreamPart(running, spawn('complete', 'Report: all good', false));
    expect(done[0]).toMatchObject({ toolChainState: 'complete', toolSubagentId: 'child-1', text: 'Report: all good' });
  });

  it('retags pre-tool agent prose to a Clara brief when a new tool row is appended', () => {
    const parts = [
      { streamTag: 'reasoning', label: 'Model reasoning', text: 'first think' },
      { streamTag: toolTrailStatusStreamTag('run-1'), label: 'read_workspace_file', text: 'done' },
      { streamTag: 'agent', label: '', text: 'I should list files next' },
    ];
    const status: LlmStatus = {
      id: 'run-2',
      label: 'list_workspace_directory',
      detail: 'Listing…',
      state: 'running',
      source: 'tool',
    };
    const out = upsertToolTrailStatusStreamPart(parts, status);
    expect(out.map((p) => p.streamTag)).toEqual([
      'reasoning',
      toolTrailStatusStreamTag('run-1'),
      'clara',
      toolTrailStatusStreamTag('run-2'),
    ]);
    expect(out[2]?.text).toBe('I should list files next');
  });

  it('keeps the brief when a streamed tool-call preview lands before clear_primary_stream', () => {
    // Backend order for a tool step: live `agent` chunks, then a `source: 'tool'` preview row
    // (native tool_call_chunks / Gemma peek) during streaming, then `clear_primary_stream` at
    // on_chat_model_end, then on_tool_start reusing the preview id.
    let parts: StreamPart[] = [];
    parts = appendStreamPart(parts, 'agent', 'Let me check the layout ');
    parts = appendStreamPart(parts, 'agent', 'before editing.');
    const preview: LlmStatus = {
      id: 'native-tool-preview-1',
      label: 'read_workspace_file',
      detail: 'src/app.ts',
      state: 'running',
      source: 'tool',
    };
    parts = upsertToolTrailStatusStreamPart(parts, preview);
    parts = clearPrimaryStreamParts(parts);
    parts = upsertToolTrailStatusStreamPart(parts, { ...preview, detail: 'ok (120 chars)', state: 'complete' });

    expect(parts.map((p) => p.streamTag)).toEqual(['clara', toolTrailStatusStreamTag('native-tool-preview-1')]);
    expect(parts[0]?.text).toBe('Let me check the layout before editing.');
    const feed = buildTurnFeed(parts, 'Done.');
    expect(feed.map((item) => item.kind)).toEqual(['markdown', 'tool', 'markdown']);
    expect(feed.some((item) => item.kind === 'thought')).toBe(false);
  });
});

describe('upsertClaraOuterBriefStreamPart', () => {
  it('appends a Clara brief from an agent-source status row', () => {
    const status: LlmStatus = {
      id: 'outer-brief-1',
      label: 'Clara',
      detail: 'Checking the layout next.',
      state: 'complete',
      source: 'agent',
      streamTag: 'clara',
    };
    const out = upsertClaraOuterBriefStreamPart([], status);
    expect(out).toEqual([
      { streamTag: 'clara', label: 'Clara', text: 'Checking the layout next.' },
    ]);
  });

  it('does not duplicate a brief whose text is already in the timeline', () => {
    const parts = [{ streamTag: 'clara', label: 'Clara', text: 'Checking the layout next.\nMore.' }];
    const status: LlmStatus = {
      id: 'outer-brief-1',
      label: 'Clara',
      detail: 'Checking the layout next.',
      state: 'complete',
      source: 'agent',
      streamTag: 'clara',
    };
    expect(upsertClaraOuterBriefStreamPart(parts, status)).toEqual(parts);
  });

  it('ignores non-clara status tags', () => {
    const status: LlmStatus = {
      id: 'agent-1',
      label: 'Agent',
      detail: 'Thinking',
      state: 'running',
      source: 'agent',
      streamTag: 'agent',
    };
    expect(upsertClaraOuterBriefStreamPart([], status)).toEqual([]);
  });
});

describe('appendStreamPart', () => {
  it('starts a new reasoning part after a tool-trail row', () => {
    const trail = toolTrailStatusStreamTag('run-1');
    const parts = [
      { streamTag: 'reasoning', label: 'Model reasoning', text: 'first think' },
      { streamTag: trail, label: 'read_workspace_file', text: 'done' },
    ];
    const out = appendStreamPart(parts, 'reasoning', 'next think', '', 5_000);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      streamTag: 'reasoning',
      label: 'Model reasoning',
      text: 'next think',
      thoughtStartedAt: 5_000,
    });
    expect(out[0]?.text).toBe('first think');
  });

  it('times a thought from its first chunk until the reply starts', () => {
    let parts: StreamPart[] = [];
    parts = appendStreamPart(parts, 'reasoning', 'let me ', '', 1_000);
    parts = appendStreamPart(parts, 'reasoning', 'think', '', 4_000);
    expect(parts[0]).toMatchObject({ thoughtStartedAt: 1_000 });
    expect(parts[0]?.thoughtDurationMs).toBeUndefined();
    parts = appendStreamPart(parts, undefined, 'Answer', '', 13_500);
    expect(parts[0]).toMatchObject({ text: 'let me think', thoughtDurationMs: 12_500 });
    // Later segments never restamp it.
    parts = appendStreamPart(parts, 'reasoning', 'more', '', 20_000);
    expect(parts[0]?.thoughtDurationMs).toBe(12_500);
  });

  it('does not time reasoning parts from older turns that carry no start time', () => {
    const parts = [{ streamTag: 'reasoning', label: 'Model reasoning', text: 'old' }];
    const out = appendStreamPart(parts, undefined, 'Answer', '', 9_000);
    expect(out[0]?.thoughtDurationMs).toBeUndefined();
  });

  it('retags pre-tool agent prose to a Clara brief when a tool-like stream starts', () => {
    const parts = [
      { streamTag: 'tool-trail:a', label: 'read', text: 'done' },
      { streamTag: 'agent', label: '', text: 'I should list files' },
    ];
    const out = appendStreamPart(parts, 'tool-pytest', 'output', 'T');
    expect(out.map((p) => p.streamTag)).toEqual(['tool-trail:a', 'clara', 'tool-pytest']);
    expect(out[1]?.text).toBe('I should list files');
  });
});
