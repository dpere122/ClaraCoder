import { ipcMain } from 'electron';
import type { OpenAiCompatEndpoint, OpenAiCompatListResult, OpenAiCompatTestResult } from '../../../shared/openai-compat';
import { openAiCompatListModels, runOpenAiCompatTest } from '../../openai-compat-client';
import { assertTrustedAppRenderer } from '../assert-trusted-renderer';

function endpointFromIpc(raw: OpenAiCompatEndpoint | undefined): OpenAiCompatEndpoint {
  const headers = Array.isArray(raw?.headers) ? raw.headers : [];
  return {
    baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : '',
    headers: headers
      .filter((h) => typeof h?.key === 'string' && typeof h?.value === 'string')
      .map((h) => ({ key: h.key, value: h.value })),
  };
}

export function registerOpenAiCompatIpc(): void {
  ipcMain.handle(
    'openai-compat:list-models',
    async (event, payload: { endpoint?: OpenAiCompatEndpoint }): Promise<OpenAiCompatListResult> => {
      assertTrustedAppRenderer(event);
      return openAiCompatListModels(endpointFromIpc(payload?.endpoint));
    },
  );

  ipcMain.handle(
    'openai-compat:test',
    async (event, payload: { endpoint?: OpenAiCompatEndpoint; model?: string }): Promise<OpenAiCompatTestResult> => {
      assertTrustedAppRenderer(event);
      return runOpenAiCompatTest(endpointFromIpc(payload?.endpoint), typeof payload?.model === 'string' ? payload.model : '');
    },
  );
}
