import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuggingFaceModelFile } from '../../../shared';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', isPackaged: false },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) =>
      handlers.set(channel, handler),
  },
}));
vi.mock('../assert-trusted-renderer', () => ({ assertTrustedAppRenderer: () => undefined }));
vi.mock('../../config/load-save', () => ({ secretStorageMode: () => 'plain' }));
vi.mock('../../state', () => ({ mainState: {} }));

import { registerModelManagerIpc } from './model-manager';

async function listFiles(names: string[]): Promise<HuggingFaceModelFile[]> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      /\/tree\//.test(String(url))
        ? new Response(JSON.stringify(names.map((path) => ({ path, size: 1, type: 'file' }))))
        : new Response(JSON.stringify({ sha: 'abc', siblings: names.map((rfilename) => ({ rfilename })) })),
    ),
  );
  const res = (await handlers.get('model-manager:list-hf-files')?.({ sender: {} }, { id: 'org/repo' })) as {
    ok: boolean;
    files: HuggingFaceModelFile[];
  };
  expect(res.ok).toBe(true);
  return res.files;
}

describe('the quant files of a repo', () => {
  beforeEach(() => {
    handlers.clear();
    registerModelManagerIpc();
  });

  it('list a draft head after the models, with its role', async () => {
    const files = await listFiles(['eagle3-gpt-oss-20b-BF16.gguf', 'eagle3-gpt-oss-20b-Q8_0.gguf', 'gpt-oss-20b-MXFP4.gguf']);
    expect(files.map((f) => [f.fileName, f.role])).toEqual([
      ['gpt-oss-20b-MXFP4.gguf', undefined],
      ['eagle3-gpt-oss-20b-BF16.gguf', 'draft'],
      ['eagle3-gpt-oss-20b-Q8_0.gguf', 'draft'],
    ]);
  });

  it('tell a head named with its kind in the middle from the model beside it', async () => {
    const files = await listFiles(['laguna-s-2.1-DFlash-BF16.gguf', 'laguna-s-2.1-Q4_K_M.gguf']);
    expect(files.map((f) => [f.fileName, f.role])).toEqual([
      ['laguna-s-2.1-Q4_K_M.gguf', undefined],
      ['laguna-s-2.1-DFlash-BF16.gguf', 'draft'],
    ]);
  });

  it('mark a vision projector, which sorts after the models and is not offered as one', async () => {
    const files = await listFiles(['mmproj-gemma-4-12B-it-BF16.gguf', 'gemma-4-12B-it-Q4_0.gguf']);
    expect(files.map((f) => [f.fileName, f.role])).toEqual([
      ['gemma-4-12B-it-Q4_0.gguf', undefined],
      ['mmproj-gemma-4-12B-it-BF16.gguf', 'mmproj'],
    ]);
  });

  it('keep the MTP role for an MTP head', async () => {
    const files = await listFiles(['gemma-4-12B-it-Q4_0.gguf', 'mtp-gemma-4-12B-it-Q4_0.gguf']);
    expect(files.map((f) => f.role)).toEqual([undefined, 'mtp']);
  });
});
