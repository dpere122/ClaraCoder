import { describe, expect, it } from 'vitest';
import type { LlmStatus } from '../../../../../shared/types/llm';
import { toolTrailStatusStreamTag } from '../../../../../shared/stream-parts';
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

  it('retags leaked agent prose to reasoning when a new tool row is appended', () => {
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
      'reasoning',
      toolTrailStatusStreamTag('run-2'),
    ]);
    expect(out[2]?.text).toBe('I should list files next');
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
    const out = appendStreamPart(parts, 'reasoning', 'next think');
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ streamTag: 'reasoning', label: 'Model reasoning', text: 'next think' });
    expect(out[0]?.text).toBe('first think');
  });

  it('retags leaked agent prose when a tool-like stream starts', () => {
    const parts = [
      { streamTag: 'tool-trail:a', label: 'read', text: 'done' },
      { streamTag: 'agent', label: '', text: 'I should list files' },
    ];
    const out = appendStreamPart(parts, 'tool-pytest', 'output', 'T');
    expect(out.map((p) => p.streamTag)).toEqual(['tool-trail:a', 'reasoning', 'tool-pytest']);
    expect(out[1]?.text).toBe('I should list files');
  });
});
