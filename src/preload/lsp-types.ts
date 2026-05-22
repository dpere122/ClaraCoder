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
