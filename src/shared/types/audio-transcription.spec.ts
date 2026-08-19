import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAI_TRANSCRIBE_MODEL,
  DEFAULT_WHISPER_MODEL,
  defaultModelForAudioProvider,
  filterDownloadedWhisperModels,
  isWhisperModelId,
  pickWhisperSettingsModel,
} from './app-config';

describe('audio transcription helpers', () => {
  it('recognizes faster-whisper size ids and not OpenAI model names', () => {
    expect(isWhisperModelId('small')).toBe(true);
    expect(isWhisperModelId('distil-large-v3')).toBe(true);
    expect(isWhisperModelId(DEFAULT_OPENAI_TRANSCRIBE_MODEL)).toBe(false);
    expect(isWhisperModelId('google-web-speech')).toBe(false);
  });

  it('picks default model per provider', () => {
    expect(defaultModelForAudioProvider('whisper')).toBe(DEFAULT_WHISPER_MODEL);
    expect(defaultModelForAudioProvider('openai')).toBe(DEFAULT_OPENAI_TRANSCRIBE_MODEL);
    expect(defaultModelForAudioProvider('disabled')).toBe(DEFAULT_OPENAI_TRANSCRIBE_MODEL);
  });

  it('filters settings sizes to downloaded Hub weights', () => {
    const opts = filterDownloadedWhisperModels(['tiny', 'small', 'unknown']);
    expect(opts.map((o) => o.value)).toEqual(['tiny', 'small']);
    expect(filterDownloadedWhisperModels([]).length).toBe(0);
  });

  it('keeps a persisted Whisper size when it is downloaded; otherwise first on disk', () => {
    expect(pickWhisperSettingsModel('small', ['tiny', 'small'])).toBe('small');
    expect(pickWhisperSettingsModel('medium', ['tiny', 'base'])).toBe('tiny');
    expect(pickWhisperSettingsModel('small', [])).toBe('small');
  });
});
