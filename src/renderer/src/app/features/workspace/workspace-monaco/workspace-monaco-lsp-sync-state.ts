import type * as Monaco from 'monaco-editor';

/** Last ``getAlternativeVersionId`` after a successful LSP buffer sync for this model. */
const lspDocumentSyncedAltVersion = new WeakMap<Monaco.editor.ITextModel, number>();

/** True when the editor buffer may differ from what the Python LSP last saw for this model. */
export function monacoModelNeedsLspDocumentSync(model: Monaco.editor.ITextModel): boolean {
  const v = lspDocumentSyncedAltVersion.get(model);
  return v === undefined || v !== model.getAlternativeVersionId();
}

export function markMonacoModelLspDocumentSynced(model: Monaco.editor.ITextModel): void {
  lspDocumentSyncedAltVersion.set(model, model.getAlternativeVersionId());
}

/** Force the next LSP call to send the live buffer (server restart, agent overwrite, disk reload). */
export function invalidateMonacoModelLspDocumentSync(model: Monaco.editor.ITextModel): void {
  lspDocumentSyncedAltVersion.delete(model);
}
