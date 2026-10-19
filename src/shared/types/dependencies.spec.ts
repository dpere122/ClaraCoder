import { describe, expect, it } from 'vitest';
import { DEPENDENCY_IDS, DEPENDENCY_SOURCES, pythonPackageUrl, whisperModelSource } from './dependencies';

describe('DEPENDENCY_SOURCES', () => {
  it('lists at least one https source for every dependency', () => {
    for (const id of DEPENDENCY_IDS) {
      expect(DEPENDENCY_SOURCES[id].length).toBeGreaterThan(0);
      for (const src of DEPENDENCY_SOURCES[id]) expect(src.url.startsWith('https://')).toBe(true);
    }
  });

  it('builds PyPI and Hugging Face links', () => {
    expect(pythonPackageUrl('fastapi')).toBe('https://pypi.org/project/fastapi/');
    expect(pythonPackageUrl('venv')).toBeNull();
    expect(whisperModelSource('small', 'Systran/faster-whisper-small').url).toBe(
      'https://huggingface.co/Systran/faster-whisper-small',
    );
  });
});
