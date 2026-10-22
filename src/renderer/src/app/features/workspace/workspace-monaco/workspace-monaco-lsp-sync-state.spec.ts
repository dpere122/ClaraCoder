import {
  invalidateMonacoModelLspDocumentSync,
  markMonacoModelLspDocumentSynced,
  monacoModelNeedsLspDocumentSync,
} from './workspace-monaco-lsp-sync-state';

describe('workspace-monaco-lsp-sync-state', () => {
  it('treats unknown models as needing sync', () => {
    let v = 0;
    const model = { getAlternativeVersionId: () => v } as import('monaco-editor').editor.ITextModel;
    expect(monacoModelNeedsLspDocumentSync(model)).toBe(true);
  });

  it('marks synced at current alternative version', () => {
    let v = 7;
    const model = { getAlternativeVersionId: () => v } as import('monaco-editor').editor.ITextModel;
    markMonacoModelLspDocumentSynced(model);
    expect(monacoModelNeedsLspDocumentSync(model)).toBe(false);
    v = 8;
    expect(monacoModelNeedsLspDocumentSync(model)).toBe(true);
  });

  it('keeps edits typed during an in-flight request unsynced', () => {
    let v = 4;
    const model = { getAlternativeVersionId: () => v } as import('monaco-editor').editor.ITextModel;
    const sent = model.getAlternativeVersionId();
    v = 5; // user typed while the request carrying version 4 was in flight
    markMonacoModelLspDocumentSynced(model, sent);
    expect(monacoModelNeedsLspDocumentSync(model)).toBe(true);
  });

  it('invalidate forces the next call to send the live buffer', () => {
    let v = 3;
    const model = { getAlternativeVersionId: () => v } as import('monaco-editor').editor.ITextModel;
    markMonacoModelLspDocumentSynced(model);
    expect(monacoModelNeedsLspDocumentSync(model)).toBe(false);
    invalidateMonacoModelLspDocumentSync(model);
    expect(monacoModelNeedsLspDocumentSync(model)).toBe(true);
  });
});
