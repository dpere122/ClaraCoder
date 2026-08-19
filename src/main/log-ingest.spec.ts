import { mkdtempSync, readFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pythonLogIngestFetch } = vi.hoisted(() => ({
  pythonLogIngestFetch: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./python/http-client', () => ({ pythonLogIngestFetch }));

let tempLogDir = '';

vi.mock('./paths', () => ({
  getLogsDir: () => tempLogDir,
}));

import { ELECTRON_LOG_FILE_NAME, ingestElectronLog, resetElectronLogIngestBackoffForTests } from './log-ingest';

describe('ingestElectronLog', () => {
  beforeEach(() => {
    tempLogDir = mkdtempSync(path.join(os.tmpdir(), 'clara-electron-log-'));
    pythonLogIngestFetch.mockReset();
    pythonLogIngestFetch.mockResolvedValue({ ok: true });
    resetElectronLogIngestBackoffForTests();
  });

  afterEach(() => {
    rmSync(tempLogDir, { recursive: true, force: true });
  });

  it('always writes a local line even when Python ingest fails', async () => {
    pythonLogIngestFetch.mockRejectedValue(new Error('fetch failed'));
    await ingestElectronLog('WARNING', 'clara.electron.llama', 'chat llama-server process exited', 'electron');
    const text = readFileSync(path.join(tempLogDir, ELECTRON_LOG_FILE_NAME), 'utf8');
    expect(text).toMatch(/WARNING \[clara\.electron\.llama\] chat llama-server process exited/);
  });

  it('POSTs to the sidecar log ingest endpoint', async () => {
    await ingestElectronLog('INFO', 'clara.electron.llama', 'stopped managed llama-server', 'electron');
    expect(pythonLogIngestFetch).toHaveBeenCalledWith(
      '/logs/ingest',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('stopped managed llama-server'),
      }),
    );
  });

  it('skips Python ingest for a short backoff after a failure', async () => {
    pythonLogIngestFetch.mockRejectedValueOnce(new Error('down'));
    await ingestElectronLog('INFO', 'clara.electron.llama', 'first', 'electron');
    pythonLogIngestFetch.mockClear();
    await ingestElectronLog('INFO', 'clara.electron.llama', 'second', 'electron');
    expect(pythonLogIngestFetch).not.toHaveBeenCalled();
    const text = readFileSync(path.join(tempLogDir, ELECTRON_LOG_FILE_NAME), 'utf8');
    expect(text).toMatch(/first/);
    expect(text).toMatch(/second/);
  });
});
