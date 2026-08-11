import { pythonControlFetch } from './python/http-client';

/** Send a line into the Python unified log (no import cycle with `python/server`). */
export async function ingestElectronLog(
  level: string,
  logger: string,
  message: string,
  source = 'electron',
): Promise<void> {
  try {
    await pythonControlFetch('/logs/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, logger, message, source }),
    });
  } catch {
    // ignore
  }
}
