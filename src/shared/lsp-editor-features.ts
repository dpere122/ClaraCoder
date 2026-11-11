/**
 * Payloads of ``POST /lsp/editor/feature`` (``clara_coder_backend.lsp.editor_features``):
 * the LSP features beyond the core editor set, all in Monaco's 1-based coordinates.
 */

export interface LspWireRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface LspWireTextEdit {
  range: LspWireRange;
  newText: string;
}

export interface LspWireLocation {
  /** Workspace-relative path. */
  relativePath: string;
  range: LspWireRange;
  /** Set when the target is a read-only page the server generated outside the workspace. */
  externalPath?: string;
  name?: string;
  detail?: string;
  kind?: number;
  containerName?: string;
}

export interface LspWireColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface LspWireInlayHint {
  position: { lineNumber: number; column: number };
  label: string;
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  tooltip?: string | { value: string; isTrusted?: boolean };
  textEdits?: LspWireTextEdit[];
  /** The server's own hint, sent back to ``inlayHint/resolve``. */
  lspHint?: Record<string, unknown>;
}

export interface LspEditorFeatureResults {
  implementation: { locations: LspWireLocation[] };
  typeDefinition: { locations: LspWireLocation[] };
  declaration: { locations: LspWireLocation[] };
  callHierarchy: { locations: LspWireLocation[] };
  typeHierarchy: { locations: LspWireLocation[] };
  prepareRename: { range: LspWireRange | null; placeholder: string | null; defaultBehavior?: boolean };
  foldingRanges: { ranges: Array<{ start: number; end: number; kind?: string | null }> };
  selectionRanges: { selections: LspWireRange[][] };
  documentColors: { colors: Array<{ range: LspWireRange; color: LspWireColor }> };
  colorPresentations: { presentations: Array<{ label: string; textEdit?: LspWireTextEdit }> };
  documentLinks: {
    links: Array<{ range: LspWireRange; relativePath?: string; url?: string; tooltip?: string }>;
  };
  inlayHintResolve: { hint: LspWireInlayHint | null };
  semanticTokensRange: {
    payload: {
      legend: { tokenTypes: string[]; tokenModifiers: string[] };
      data: number[];
      resultId?: string | null;
    };
  };
}

export type LspEditorFeature = keyof LspEditorFeatureResults;

export type LspEditorFeatureResponse<F extends LspEditorFeature> =
  | { ok: true; result: LspEditorFeatureResults[F]; syncedFromDisk: boolean }
  | { ok: false; error: string };

export interface LspFileRenameIpc {
  oldRelativePath: string;
  newRelativePath: string;
}
