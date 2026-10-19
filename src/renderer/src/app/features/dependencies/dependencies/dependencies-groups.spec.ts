import { describe, expect, it } from 'vitest';
import type { DependencyInfo } from '@shared/index';
import { groupDependencies, installedLlamaVariant } from './dependencies';

function dep(id: string, extra: Partial<DependencyInfo> = {}): DependencyInfo {
  return {
    id: id as DependencyInfo['id'],
    label: id,
    description: '',
    version: null,
    state: 'installed',
    path: null,
    sizeHint: '',
    canDelete: true,
    ...extra,
  };
}

describe('groupDependencies', () => {
  it('orders rows into Required, Language servers, and Voice', () => {
    const groups = groupDependencies([dep('whisper'), dep('java-lsp'), dep('llama-server'), dep('python-runtime'), dep('kokoro')]);
    expect(groups.map((g) => [g.label, g.deps.map((d) => d.id)])).toEqual([
      ['Required', ['python-runtime', 'llama-server']],
      ['Language servers', ['java-lsp']],
      ['Voice', ['kokoro', 'whisper']],
    ]);
    expect(groups.find((g) => g.id === 'voice')?.comingSoon).toBe(true);
  });

  it('drops empty groups and keeps unknown ids under Other', () => {
    const groups = groupDependencies([dep('python-runtime'), dep('future-thing')]);
    expect(groups.map((g) => g.label)).toEqual(['Required', 'Other']);
  });
});

describe('installedLlamaVariant', () => {
  it('reads the variant component the provider reports', () => {
    expect(installedLlamaVariant(dep('llama-server', { components: ['llama-server', 'variant: cuda-13'] }))).toBe('cuda-13');
  });

  it('ignores unknown variants and missing installs', () => {
    expect(installedLlamaVariant(dep('llama-server', { components: ['variant: weird'] }))).toBeNull();
    expect(installedLlamaVariant(dep('llama-server', { state: 'missing', components: ['variant: cpu'] }))).toBeNull();
  });
});
