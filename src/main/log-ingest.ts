import { appendFile, mkdir } from 'fs/promises';
import path = require('path');

import { pythonLogIngestFetch } from './python/http-client';
import { getLogsDir } from './paths';

/** Sidecar-independent Electron log (survives a hung/dead Python process). */
export const ELECTRON_LOG_FILE_NAME = 'clara-electron.log';

const INGEST_BACKOFF_MS = 5_000;
let ingestBackoffUntil = 0;

/** Test-only: clear the Python ingest backoff window. */
export function resetElectronLogIngestBackoffForTests(): void {
  ingestBackoffUntil = 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local timestamp matching Python ``clara-app.log`` (``%Y-%m-%d %H:%M:%S``). */
export function formatElectronLogTimestamp(d = new Date()): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function oneLine(message: string): string {
  return (message || '').replace(/[\r\n]+/g, ' ').trimEnd();
}

export async function appendLocalElectronLog(
  level: string,
  logger: string,
  message: string,
): Promise<void> {
  try {
    const dir = getLogsDir();
    await mkdir(dir, { recursive: true });
    const line = `${formatElectronLogTimestamp()} ${level} [${logger}] ${oneLine(message)}\n`;
    await appendFile(path.join(dir, ELECTRON_LOG_FILE_NAME), line, 'utf8');
  } catch {
    /* ignore */
  }
}

/** Send a line into the Python unified log (no import cycle with `python/server`). */
export async function ingestElectronLog(
  level: string,
  logger: string,
  message: string,
  source = 'electron',
): Promise<void> {
  await appendLocalElectronLog(level, logger, message);
  if (Date.now() < ingestBackoffUntil) {
    return;
  }
  try {
    await pythonLogIngestFetch('/logs/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, logger, message, source }),
    });
  } catch {
    ingestBackoffUntil = Date.now() + INGEST_BACKOFF_MS;
  }
}
