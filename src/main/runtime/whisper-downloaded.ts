/**
 * Scan ``{customModelsDir}/whisper`` for faster-whisper Hub snapshots.
 * Used so Settings can list sizes even when the sidecar omits ``downloadedModels``.
 */
import { existsSync, readdirSync } from 'fs';
import path = require('path');
import {
  WHISPER_MODEL_OPTIONS,
  WHISPER_SIZE_REPOS,
  whisperHubCacheDirname,
} from '../../shared';

function snapshotHasWeights(snapshotsDir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(snapshotsDir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const snap = path.join(snapshotsDir, name);
    if (existsSync(path.join(snap, 'model.bin')) || existsSync(path.join(snap, 'config.json'))) {
      return true;
    }
  }
  return false;
}

/** Whisper size ids that have Hub weights under ``{modelsRoot}/whisper``. */
export function listDownloadedWhisperModels(modelsRoot: string): string[] {
  const whisperRoot = path.join(modelsRoot, 'whisper');
  const found: string[] = [];
  for (const opt of WHISPER_MODEL_OPTIONS) {
    const repo = WHISPER_SIZE_REPOS[opt.value];
    if (!repo) continue;
    const base = path.join(whisperRoot, whisperHubCacheDirname(repo), 'snapshots');
    if (snapshotHasWeights(base)) {
      found.push(opt.value);
    }
  }
  return found;
}

/** Prefer Python's list, then fill from disk; keep Settings option order. */
export function mergeWhisperDownloadedModels(
  fromStatus: readonly string[] | undefined,
  fromDisk: readonly string[],
): string[] {
  const merged = new Set<string>([
    ...(Array.isArray(fromStatus) ? fromStatus : []),
    ...fromDisk,
  ]);
  return WHISPER_MODEL_OPTIONS.map((o) => o.value).filter((id) => merged.has(id));
}
