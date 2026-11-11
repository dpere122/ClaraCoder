import { describe, expect, it } from 'vitest';
import type { DependencyInfo } from '@shared/index';
import { dependencyUpdateHint, groupDependencies, installedLlamaVariant } from './dependencies';

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
    const groups = groupDependencies([dep('whisper'), dep('gdls'), dep('java-lsp'), dep('llama-server'), dep('kokoro')]);
    expect(groups.map((g) => [g.label, g.deps.map((d) => d.id)])).toEqual([
      ['Required', ['llama-server']],
      ['Language servers', ['java-lsp', 'gdls']],
      ['Voice', ['kokoro', 'whisper']],
    ]);
    expect(groups.find((g) => g.id === 'voice')?.comingSoon).toBe(true);
  });

  it('drops empty groups and keeps unknown ids under Other', () => {
    const groups = groupDependencies([dep('llama-server'), dep('future-thing')]);
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

describe('dependencyUpdateHint', () => {
  it('names the build a reinstall would fetch when the install is behind it', () => {
    const hint = dependencyUpdateHint(dep('llama-server', { version: 'b10867 (cuda-13.5)', updateAvailable: 'b12182' }));
    expect(hint).toContain('b12182');
    expect(hint).toContain('Reinstall');
  });

  it('says nothing for a current install or one that is not installed', () => {
    expect(dependencyUpdateHint(dep('llama-server'))).toBeNull();
    expect(dependencyUpdateHint(dep('llama-server', { updateAvailable: null }))).toBeNull();
    expect(dependencyUpdateHint(dep('llama-server', { state: 'updating', updateAvailable: 'b12182' }))).toBeNull();
  });
});
