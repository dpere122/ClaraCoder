import {
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
});
