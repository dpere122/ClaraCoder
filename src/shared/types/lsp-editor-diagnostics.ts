/** Normalized LSP diagnostic row (Python cache + Monaco markers). */
export interface LspEditorDiagnostic {
  readonly relative_path: string;
  readonly message: string;
  readonly severity: string;
  readonly severity_value: number;
  readonly code: string;
  readonly source: string;
  readonly line: number;
  readonly character: number;
  readonly end_line: number;
  readonly end_character: number;
}

export interface LspEditorDiagnosticsPayload {
  readonly diagnostics: LspEditorDiagnostic[];
  readonly generation: number;
}
