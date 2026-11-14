import { describe, expect, it } from 'vitest';
import {
  defaultDependencyCatalog,
  DEPENDENCY_COMPONENTS,
  DEPENDENCY_DESCRIPTIONS,
  DEPENDENCY_IDS,
  DEPENDENCY_LABELS,
  DEPENDENCY_SIZE_HINTS,
  DEPENDENCY_SOURCES,
  whisperModelSource,
} from './dependencies';

describe('DEPENDENCY_SOURCES', () => {
  it('lists at least one https source for every dependency', () => {
    for (const id of DEPENDENCY_IDS) {
      expect(DEPENDENCY_SOURCES[id].length).toBeGreaterThan(0);
      for (const src of DEPENDENCY_SOURCES[id]) expect(src.url.startsWith('https://')).toBe(true);
    }
  });

  it('does not list the Python runtime, which ships with the app', () => {
    expect(DEPENDENCY_IDS as readonly string[]).not.toContain('python-runtime');
  });

  it('lists vtsls as a language server download with every catalog field', () => {
    expect(DEPENDENCY_IDS).toContain('vtsls');
    expect(DEPENDENCY_LABELS.vtsls).toBe('TypeScript/JS LSP (vtsls)');
    expect(DEPENDENCY_DESCRIPTIONS.vtsls).not.toBe('');
    expect(DEPENDENCY_SIZE_HINTS.vtsls).not.toBe('');
    expect(DEPENDENCY_COMPONENTS.vtsls).toEqual(['@vtsls/language-server', 'typescript']);
    expect(DEPENDENCY_SOURCES.vtsls.some((src) => src.detail.includes('registry.npmjs.org'))).toBe(true);
    const row = defaultDependencyCatalog().find((dep) => dep.id === 'vtsls');
    expect(row?.state).toBe('missing');
  });

  it('builds Hugging Face model links', () => {
    expect(whisperModelSource('small', 'Systran/faster-whisper-small').url).toBe(
      'https://huggingface.co/Systran/faster-whisper-small',
    );
  });
});
