import type * as Monaco from 'monaco-editor';
import type { LspEditorDiagnostic } from '@shared/index';

const LSP_MARKER_OWNER = 'lsp';

/** Map LSP severity (1=error … 4=hint) to Monaco marker severity. */
function markerSeverity(value: number): Monaco.MarkerSeverity {
  switch (value) {
    case 1:
      return 8; // Error
    case 2:
      return 4; // Warning
    case 3:
      return 2; // Info
    case 4:
      return 1; // Hint
    default:
      return 8;
  }
}

export function lspDiagnosticsToMonacoMarkers(
  api: typeof Monaco,
  items: readonly LspEditorDiagnostic[],
): Monaco.editor.IMarkerData[] {
  const markers: Monaco.editor.IMarkerData[] = [];
  for (const d of items) {
    const message = d.message?.trim();
    if (!message) {
      continue;
    }
    const source = d.source?.trim();
    const code = d.code?.trim();
    let fullMessage = message;
    if (source) {
      fullMessage = code ? `${source}(${code}): ${message}` : `${source}: ${message}`;
    }
    markers.push({
      severity: markerSeverity(d.severity_value),
      message: fullMessage,
      startLineNumber: Math.max(1, d.line),
      startColumn: Math.max(1, d.character),
      endLineNumber: Math.max(1, d.end_line || d.line),
      endColumn: Math.max(1, d.end_character || d.character + 1),
      source: source || 'LSP',
      code: code || undefined,
    });
  }
  return markers;
}

export function applyLspDiagnosticsToModel(
  api: typeof Monaco,
  model: Monaco.editor.ITextModel,
  items: readonly LspEditorDiagnostic[],
): void {
  const markers = lspDiagnosticsToMonacoMarkers(api, items);
  api.editor.setModelMarkers(model, LSP_MARKER_OWNER, markers);
}

export function clearLspDiagnosticsFromModel(api: typeof Monaco, model: Monaco.editor.ITextModel): void {
  api.editor.setModelMarkers(model, LSP_MARKER_OWNER, []);
}

export { LSP_MARKER_OWNER };
