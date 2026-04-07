import { PYTHON_PORT } from './constants';

const PYTHON_URL = `http://127.0.0.1:${PYTHON_PORT}`;

/** Send a line into the Python unified log (no import cycle with `python/server`). */
export async function ingestElectronLog(
  level: string,
  logger: string,
  message: string,
  source = 'electron',
): Promise<void> {
  try {
    await fetch(`${PYTHON_URL}/logs/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, logger, message, source }),
    });
  } catch {
    // ignore
  }
}
