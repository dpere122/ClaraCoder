import { describe, expect, it } from 'vitest';
import type { LlmStatus } from '../../../../../shared/types/llm';
import { toolTrailStatusStreamTag } from '../../../../../shared/stream-parts';
import { mergeToolTrailStatusText, upsertToolTrailStatusStreamPart } from './app-stream-parts';

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
});
