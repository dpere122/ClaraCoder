import type * as Monaco from 'monaco-editor';

/** Last ``getAlternativeVersionId`` after a successful LSP buffer sync for this model. */
const lspDocumentSyncedAltVersion = new WeakMap<Monaco.editor.ITextModel, number>();

/** True when the editor buffer may differ from what the Python LSP last saw for this model. */
export function monacoModelNeedsLspDocumentSync(model: Monaco.editor.ITextModel): boolean {
  const v = lspDocumentSyncedAltVersion.get(model);
  return v === undefined || v !== model.getAlternativeVersionId();
}

/**
 * Record a successful buffer sync. Pass ``sentAltVersion`` — the version captured when the text
 * was read for the request — so edits typed while the request was in flight still count as
 * unsynced; marking with the version current at response time would skip sending them.
 */
export function markMonacoModelLspDocumentSynced(
  model: Monaco.editor.ITextModel,
  sentAltVersion: number = model.getAlternativeVersionId(),
): void {
  lspDocumentSyncedAltVersion.set(model, sentAltVersion);
}

/** Force the next LSP call to send the live buffer (server restart, agent overwrite, disk reload). */
export function invalidateMonacoModelLspDocumentSync(model: Monaco.editor.ITextModel): void {
  lspDocumentSyncedAltVersion.delete(model);
}
