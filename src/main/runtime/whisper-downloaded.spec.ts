import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { describe, expect, it } from 'vitest';
import { whisperHubCacheDirname } from '../../shared';
import { listDownloadedWhisperModels, mergeWhisperDownloadedModels } from './whisper-downloaded';

describe('listDownloadedWhisperModels', () => {
  it('detects Hub snapshots with model.bin under {modelsRoot}/whisper', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'clara-whisper-'));
    const snap = path.join(
      root,
      'whisper',
      whisperHubCacheDirname('Systran/faster-whisper-small'),
      'snapshots',
      'abc123',
    );
    mkdirSync(snap, { recursive: true });
    writeFileSync(path.join(snap, 'model.bin'), 'weights');
    expect(listDownloadedWhisperModels(root)).toEqual(['small']);
  });

  it('detects snapshots that only have config.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'clara-whisper-'));
    const snap = path.join(
      root,
      'whisper',
      whisperHubCacheDirname('Systran/faster-whisper-tiny'),
      'snapshots',
      'def456',
    );
    mkdirSync(snap, { recursive: true });
    writeFileSync(path.join(snap, 'config.json'), '{}');
    expect(listDownloadedWhisperModels(root)).toEqual(['tiny']);
  });

  it('returns empty when the whisper cache is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'clara-whisper-'));
    expect(listDownloadedWhisperModels(root)).toEqual([]);
  });
});

describe('mergeWhisperDownloadedModels', () => {
  it('unions Python status with disk scan and keeps option order', () => {
    expect(mergeWhisperDownloadedModels(['small'], ['tiny', 'small'])).toEqual(['tiny', 'small']);
    expect(mergeWhisperDownloadedModels(undefined, ['medium'])).toEqual(['medium']);
    expect(mergeWhisperDownloadedModels(['nope'], [])).toEqual([]);
  });
});
