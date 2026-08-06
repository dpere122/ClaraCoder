import { ipcRenderer } from 'electron';
import type {
  HealthLogRecord,
  HealthMetricsSnapshot,
  LspDashboardStatus,
  RuntimeHealthSnapshot,
} from '../../shared';
import type {
  LspEditorCodeActionIpc,
  LspEditorCodeLensIpc,
  LspEditorCompletionItemIpc,
  LspEditorDiagnosticIpc,
  LspEditorDocumentHighlightIpc,
  LspEditorDocumentSymbolIpc,
  LspEditorFlatSymbolIpc,
  LspEditorInlayHintIpc,
  LspEditorLocationIpc,
  LspEditorSignatureHelpIpc,
  LspEditorTextEditIpc,
  LspSemanticTokensFullIpc,
  LspSemanticTokensLegendIpc,
  LspWorkspaceEditIpc,
} from '../lsp-types';

/** LSP dashboard, editor features, and health metrics IPC. */
export const lspHealthApi = {
  healthMetrics: () => ipcRenderer.invoke('health-metrics') as Promise<HealthMetricsSnapshot>,
  healthRuntimeSnapshot: () =>
    ipcRenderer.invoke('health-runtime-snapshot') as Promise<RuntimeHealthSnapshot>,
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
    ) as Promise<{ ok: true; markdown: string | null; range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null; syncedFromDisk?: boolean } | { ok: false; error: string }>,
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
  lspEditorDiagnostics: (sessionId: string, relativePath: string, documentText: string, skipDocumentSync?: boolean) =>
    ipcRenderer.invoke(
      'lsp-editor-diagnostics',
      sessionId,
      relativePath,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; diagnostics: LspEditorDiagnosticIpc[]; generation: number }
      | { ok: false; error: string }
    >,
  lspDiagnosticsGeneration: (sessionId: string, relativePath: string) =>
    ipcRenderer.invoke('lsp-diagnostics-generation', sessionId, relativePath) as Promise<
      | { ok: true; generation: number; count: number }
      | { ok: false; error: string }
    >,
  lspEditorSignatureHelp: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    triggerCharacter: string | null,
    isRetrigger: boolean,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-signature-help',
      sessionId,
      relativePath,
      line,
      character,
      documentText,
      triggerCharacter,
      isRetrigger,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; signatureHelp: LspEditorSignatureHelpIpc | null }
      | { ok: false; error: string }
    >,
  lspEditorDocumentHighlight: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-document-highlight',
      sessionId,
      relativePath,
      line,
      character,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; highlights: LspEditorDocumentHighlightIpc[] }
      | { ok: false; error: string }
    >,
  lspEditorCompletionResolve: (sessionId: string, relativePath: string, item: Record<string, unknown>) =>
    ipcRenderer.invoke('lsp-editor-completion-resolve', sessionId, relativePath, item) as Promise<
      | { ok: true; item: LspEditorCompletionItemIpc }
      | { ok: false; error: string }
    >,
  lspEditorCodeAction: (
    sessionId: string,
    relativePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    documentText: string,
    diagnostics: LspEditorDiagnosticIpc[],
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-code-action',
      sessionId,
      relativePath,
      startLine,
      startCharacter,
      endLine,
      endCharacter,
      documentText,
      diagnostics,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; actions: LspEditorCodeActionIpc[] }
      | { ok: false; error: string }
    >,
  lspEditorFormatting: (
    sessionId: string,
    relativePath: string,
    documentText: string,
    tabSize: number,
    insertSpaces: boolean,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-formatting',
      sessionId,
      relativePath,
      documentText,
      tabSize,
      insertSpaces,
      skipDocumentSync === true,
    ) as Promise<{ ok: true; edits: LspEditorTextEditIpc[] } | { ok: false; error: string }>,
  lspEditorRangeFormatting: (
    sessionId: string,
    relativePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    documentText: string,
    tabSize: number,
    insertSpaces: boolean,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-range-formatting',
      sessionId,
      relativePath,
      startLine,
      startCharacter,
      endLine,
      endCharacter,
      documentText,
      tabSize,
      insertSpaces,
      skipDocumentSync === true,
    ) as Promise<{ ok: true; edits: LspEditorTextEditIpc[] } | { ok: false; error: string }>,
  lspEditorOnTypeFormatting: (
    sessionId: string,
    relativePath: string,
    line: number,
    character: number,
    ch: string,
    documentText: string,
    tabSize: number,
    insertSpaces: boolean,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-on-type-formatting',
      sessionId,
      relativePath,
      line,
      character,
      ch,
      documentText,
      tabSize,
      insertSpaces,
      skipDocumentSync === true,
    ) as Promise<{ ok: true; edits: LspEditorTextEditIpc[] } | { ok: false; error: string }>,
  lspEditorInlayHints: (
    sessionId: string,
    relativePath: string,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
    documentText: string,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-inlay-hints',
      sessionId,
      relativePath,
      startLine,
      startCharacter,
      endLine,
      endCharacter,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; hints: LspEditorInlayHintIpc[] }
      | { ok: false; error: string }
    >,
  lspEditorCodeLens: (sessionId: string, relativePath: string, documentText: string, skipDocumentSync?: boolean) =>
    ipcRenderer.invoke(
      'lsp-editor-code-lens',
      sessionId,
      relativePath,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | { ok: true; lenses: LspEditorCodeLensIpc[] }
      | { ok: false; error: string }
    >,
  lspEditorCodeLensResolve: (sessionId: string, relativePath: string, lens: Record<string, unknown>) =>
    ipcRenderer.invoke('lsp-editor-code-lens-resolve', sessionId, relativePath, lens) as Promise<
      | { ok: true; lens: LspEditorCodeLensIpc | null }
      | { ok: false; error: string }
    >,
  lspEditorSemanticTokensDelta: (
    sessionId: string,
    relativePath: string,
    previousResultId: string,
    documentText: string,
    skipDocumentSync?: boolean,
  ) =>
    ipcRenderer.invoke(
      'lsp-editor-semantic-tokens-delta',
      sessionId,
      relativePath,
      previousResultId,
      documentText,
      skipDocumentSync === true,
    ) as Promise<
      | {
          ok: true;
          payload: {
            legend: { tokenTypes: string[]; tokenModifiers: string[] };
            resultId: string | null;
            edits: unknown[];
          };
        }
      | { ok: false; error: string }
    >,
  onLspDiagnosticsUpdated: (callback: (event: unknown, payload: { sessionId: string; relativePath: string; generation: number }) => void) =>
    ipcRenderer.on('lsp-diagnostics-updated', callback),
  lspDiagnosticsWatchStart: (sessionId: string, relativePath: string) =>
    ipcRenderer.send('lsp-diagnostics-watch-start', sessionId, relativePath),
  lspDiagnosticsWatchStop: () => ipcRenderer.send('lsp-diagnostics-watch-stop'),
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
