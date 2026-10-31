import { describe, expect, it } from 'vitest';
import { DEPENDENCY_IDS, DEPENDENCY_SOURCES, whisperModelSource } from './dependencies';

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

  it('builds Hugging Face model links', () => {
    expect(whisperModelSource('small', 'Systran/faster-whisper-small').url).toBe(
      'https://huggingface.co/Systran/faster-whisper-small',
    );
  });
});
