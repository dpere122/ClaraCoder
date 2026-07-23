export interface LspEditorIRangeIpc {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface LspEditorLocationIpc {
  relativePath: string;
  range: LspEditorIRangeIpc;
}

export interface LspEditorDocumentSymbolIpc {
  name: string;
  kind?: number;
  detail?: string;
  range: LspEditorIRangeIpc;
  selectionRange: LspEditorIRangeIpc;
  children?: LspEditorDocumentSymbolIpc[];
}

/** Alias used by outline UI (same wire shape as document symbols). */
export type LspEditorDocumentSymbolWire = LspEditorDocumentSymbolIpc;

export interface LspEditorFlatSymbolIpc {
  name: string;
  kind?: number;
  containerName?: string;
  relativePath: string;
  range: LspEditorIRangeIpc;
}

export interface LspEditorTextEditIpc {
  range: LspEditorIRangeIpc;
  newText: string;
}

export interface LspEditorCompletionItemIpc {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string; isTrusted?: boolean };
  filterText?: string;
  sortText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspEditorTextEditIpc;
  additionalTextEdits?: LspEditorTextEditIpc[];
}

export interface LspWorkspaceEditIpc {
  changes: Record<string, LspEditorTextEditIpc[]>;
}

export interface LspSemanticTokensLegendIpc {
  tokenTypes: string[];
  tokenModifiers: string[];
  supported: boolean;
}

export interface LspSemanticTokensFullIpc {
  legend: { tokenTypes: string[]; tokenModifiers: string[] };
  data: number[];
  resultId: string | null;
}

export interface LspEditorDiagnosticIpc {
  relative_path: string;
  message: string;
  severity: string;
  severity_value: number;
  code: string;
  source: string;
  line: number;
  character: number;
  end_line: number;
  end_character: number;
}

export interface LspEditorSignatureHelpIpc {
  signatures: Array<{
    label: string;
    documentation?: string | { value: string; isTrusted?: boolean };
    parameters?: Array<{
      label: string;
      documentation?: string | { value: string; isTrusted?: boolean };
    }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export interface LspEditorDocumentHighlightIpc {
  range: LspEditorIRangeIpc;
  kind?: number;
}

export interface LspEditorCodeActionIpc {
  title: string;
  kind: string;
  isPreferred?: boolean;
  edit?: LspWorkspaceEditIpc;
  command?: { title: string; command: string; arguments?: unknown };
}

export interface LspEditorInlayHintIpc {
  position: { lineNumber: number; column: number };
  label: string;
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  tooltip?: string | { value: string; isTrusted?: boolean };
}

export interface LspEditorCodeLensIpc {
  range: LspEditorIRangeIpc;
  command?: { title: string; command: string; arguments?: unknown };
  data?: unknown;
}

export interface LspEditorCompletionItemIpcExtended extends LspEditorCompletionItemIpc {
  data?: unknown;
}
