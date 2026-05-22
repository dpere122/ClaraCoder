import { ipcRenderer } from 'electron';
import type { HealthLogRecord, HealthMetricsSnapshot, LspDashboardStatus } from '../../shared';
import type {
  LspEditorCompletionItemIpc,
  LspEditorDocumentSymbolIpc,
  LspEditorFlatSymbolIpc,
  LspEditorLocationIpc,
  LspSemanticTokensFullIpc,
  LspSemanticTokensLegendIpc,
  LspWorkspaceEditIpc,
} from '../lsp-types';

/** LSP dashboard, editor features, and health metrics IPC. */
export const lspHealthApi = {
  healthMetrics: () => ipcRenderer.invoke('health-metrics') as Promise<HealthMetricsSnapshot>,
  getLspDashboardStatus: (sessionId: string) =>
    ipcRenderer.invoke('get-lsp-dashboard-status', sessionId) as Promise<
      { ok: true; status: LspDashboardStatus } | { ok: false; error: string }
    >,
  warmLspForActiveFile: (sessionId: string, relativePath: string, encoding?: string) =>
    ipcRenderer.invoke('warm-lsp-for-active-file', sessionId, relativePath, encoding) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  warmLspServer: (sessionId: string, server: string) =>
    ipcRenderer.invoke('warm-lsp-server', sessionId, server) as Promise<{ ok: true } | { ok: false; error: string }>,
  lspEditorHover: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-hover',
      sessionId,
      relativePath,
      line,
      character,
      documentText,
      skipDocumentSync === true,
    ) as Promise<{ ok: true; markdown: string | null } | { ok: false; error: string }>,
  lspEditorDefinition: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-definition',
      sessionId,
      relativePath,
      line,
      character,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; locations: LspEditorLocationIpc[] }
      | { ok: false; error: string }
    >,
  lspEditorReferences: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    includeDeclaration: boolean,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-references',
      sessionId,
      relativePath,
      line,
      character,
      documentText,
      includeDeclaration,
      skipDocumentSync === true,
    ) as Promise<{ ok: true; locations: LspEditorLocationIpc[] } | { ok: false; error: string }>,
  lspEditorDocumentSymbols: (sessionId: string, relativePath: string, documentText: string, skipDocumentSync?: boolean) =>
    ipcRenderer.invoke(
      'lsp-editor-document-symbols',
      sessionId,
      relativePath,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; hierarchical: LspEditorDocumentSymbolIpc[]; flat: LspEditorFlatSymbolIpc[] }
      | { ok: false; error: string }
    >,
  lspEditorCompletion: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    triggerKind: number,
    triggerCharacter: string | null,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-completion',
      sessionId,
      relativePath,
      line,
      character,
      documentText,
      triggerKind,
      triggerCharacter,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; isIncomplete: boolean; items: LspEditorCompletionItemIpc[] }
      | { ok: false; error: string }
    >,
  lspEditorRename: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    newName: string,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-rename',
      sessionId,
      relativePath,
      line,
      character,
      documentText,
      newName,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; workspaceEdit: LspWorkspaceEditIpc | null }
      | { ok: false; error: string }
    >,
  lspEditorSemanticTokensLegend: (sessionId: string, server: string) =>
    ipcRenderer.invoke('lsp-editor-semantic-tokens-legend', sessionId, server) as Promise<
      | { ok: true; legend: LspSemanticTokensLegendIpc }
      | { ok: false; error: string }
    >,
  lspEditorSemanticTokensFull: (sessionId: string, relativePath: string, documentText: string, skipDocumentSync?: boolean) =>
    ipcRenderer.invoke(
      'lsp-editor-semantic-tokens-full',
      sessionId,
      relativePath,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; payload: LspSemanticTokensFullIpc }
      | { ok: false; error: string }
    >,
  healthLogsRecent: (limit: number) =>
    ipcRenderer.invoke('health-logs-recent', limit) as Promise<{ records: HealthLogRecord[] }>,
  healthSetLogLevel: (level: string) => ipcRenderer.invoke('health-set-log-level', level) as Promise<{ ok: boolean }>,
  healthLogsSubscribe: () => ipcRenderer.send('health-logs-subscribe'),
  healthLogsUnsubscribe: () => ipcRenderer.send('health-logs-unsubscribe'),
  onHealthLogRecord: (callback: (event: unknown, record: HealthLogRecord) => void) =>
    ipcRenderer.on('health-log-record', callback),
  openHealthWindow: () => ipcRenderer.send('open-health-window'),
  closeHealthWindow: () => ipcRenderer.send('close-health-window'),
};
