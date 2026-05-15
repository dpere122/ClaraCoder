import type * as Monaco from 'monaco-editor';
import type { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import {
  LSP_MONACO_LANGUAGE_IDS,
  lspServerIdForMonacoLanguageId,
  lspServerKindForWorkspaceRelativePath,
} from '@shared/index';
import { markMonacoModelLspDocumentSynced, monacoModelNeedsLspDocumentSync } from './workspace-monaco-lsp-sync-state';

export interface WorkspaceMonacoLspNavigatePayload {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
}

export interface RegisterWorkspaceMonacoLspOptions {
  readonly monacoApi: typeof Monaco;
  readonly electron: ElectronService;
  readonly getConversationId: () => string | null;
  /** Resolve workspace-relative POSIX path for a ``clara-workspace`` model, or ``undefined``. */
  readonly getWorkspaceRelativePathForModel: (model: Monaco.editor.ITextModel) => string | undefined;
  /** Cross-file go-to-definition / reveal cursor after tab switch. */
  readonly onNavigateToWorkspaceFile: (payload: WorkspaceMonacoLspNavigatePayload) => void;
  /** Prefetched from ``GET /lsp/semantic-tokens-legend`` so ``getLegend()`` is valid on first paint. */
  readonly initialSemanticLegends?: Readonly<Record<string, Monaco.languages.SemanticTokensLegend>>;
}

function wireRange(api: typeof Monaco, r: Monaco.IRange): Monaco.Range {
  return new api.Range(
    r.startLineNumber,
    r.startColumn,
    r.endLineNumber,
    r.endColumn,
  );
}

function mapWorkspaceEdit(
  api: typeof Monaco,
  payload: { changes: Record<string, Array<{ range: Monaco.IRange; newText: string }>> },
): Monaco.languages.WorkspaceEdit {
  const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [rel, textEdits] of Object.entries(payload.changes)) {
    const uri = api.Uri.parse(`clara-workspace:///${encodeURI(rel)}`);
    for (const te of textEdits) {
      edits.push({
        resource: uri,
        versionId: undefined,
        textEdit: {
          range: wireRange(api, te.range),
          text: te.newText,
        },
      });
    }
  }
  return { edits };
}

function emptyLegend(): Monaco.languages.SemanticTokensLegend {
  return { tokenTypes: [], tokenModifiers: [] };
}

function lspCancelled(token: Monaco.CancellationToken | undefined): boolean {
  return token?.isCancellationRequested === true;
}

/**
 * Registers workspace-scoped LSP providers on the standalone editor.
 * Models must use the ``clara-workspace`` URI scheme (see ``WorkspaceMonacoComponent``).
 */
export function registerWorkspaceMonacoLsp(opts: RegisterWorkspaceMonacoLspOptions): Monaco.IDisposable {
  const {
    monacoApi: api,
    electron,
    getConversationId,
    getWorkspaceRelativePathForModel,
    onNavigateToWorkspaceFile,
    initialSemanticLegends,
  } = opts;
  const disposables: Monaco.IDisposable[] = [];

  const legends: Record<string, Monaco.languages.SemanticTokensLegend> = {};
  const init = initialSemanticLegends ?? {};
  for (const key of Object.keys(init)) {
    legends[key] = {
      tokenTypes: [...(init[key]?.tokenTypes ?? [])],
      tokenModifiers: [...(init[key]?.tokenModifiers ?? [])],
    };
  }

  const legendForMonacoLang = (monacoLang: string): Monaco.languages.SemanticTokensLegend => {
    const sid = lspServerIdForMonacoLanguageId(monacoLang);
    if (sid && legends[sid]) {
      return legends[sid]!;
    }
    return emptyLegend();
  };

  const canRun = (model: Monaco.editor.ITextModel): boolean => {
    if (!electron.isElectron || model.uri.scheme !== 'clara-workspace') {
      return false;
    }
    const rel = getWorkspaceRelativePathForModel(model);
    return !!(rel && lspServerKindForWorkspaceRelativePath(rel) && getConversationId()?.trim());
  };

  const withSessionAndDocument = <T>(
    model: Monaco.editor.ITextModel,
    fn: (sessionId: string, rel: string, text: string, skipDocumentSync: boolean) => Promise<T>,
  ): Promise<T | null> => {
    const sessionId = getConversationId()?.trim();
    const rel = getWorkspaceRelativePathForModel(model);
    if (!sessionId || !rel) {
      return Promise.resolve(null);
    }
    const skip = !monacoModelNeedsLspDocumentSync(model);
    return fn(sessionId, rel, skip ? '' : model.getValue(), skip);
  };

  for (const lang of LSP_MONACO_LANGUAGE_IDS) {
    disposables.push(
      api.languages.registerDefinitionProvider(lang, {
        provideDefinition: async (model, position, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorDefinition(sid, rel, position.lineNumber, position.column, text, skip),
          );
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok || !res.locations?.length) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          const cur = normalizePathSlashes(getWorkspaceRelativePathForModel(model) ?? '');
          const mapped = res.locations.map((loc) => ({
            uri: api.Uri.parse(`clara-workspace:///${encodeURI(normalizePathSlashes(loc.relativePath))}`),
            range: wireRange(api, loc.range),
          }));
          if (mapped.length === 1) {
            const target = normalizePathSlashes(res.locations[0].relativePath);
            if (target && target !== cur) {
              const r = res.locations[0].range;
              onNavigateToWorkspaceFile({
                relativePath: target,
                line: r.startLineNumber,
                column: r.startColumn,
              });
              return null;
            }
          }
          return mapped;
        },
      }),
    );

    disposables.push(
      api.languages.registerReferenceProvider(lang, {
        provideReferences: async (model, position, context, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorReferences(sid, rel, position.lineNumber, position.column, text, context.includeDeclaration, skip),
          );
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok || !res.locations?.length) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          return res.locations.map((loc) => ({
            uri: api.Uri.parse(`clara-workspace:///${encodeURI(normalizePathSlashes(loc.relativePath))}`),
            range: wireRange(api, loc.range),
          }));
        },
      }),
    );

    disposables.push(
      api.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: ['.', '/', '"', "'", '`', '@', '<', '#'],
        provideCompletionItems: async (model, position, context, token) => {
          if (!canRun(model)) {
            return { suggestions: [] };
          }
          const sessionId = getConversationId()?.trim();
          const rel = getWorkspaceRelativePathForModel(model);
          if (!sessionId || !rel) {
            return { suggestions: [] };
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const skip = !neededSync;
          const tk = context.triggerKind + 1;
          const tc =
            context.triggerCharacter === undefined || context.triggerCharacter === null
              ? null
              : String(context.triggerCharacter);
          const res = await electron.lspEditorCompletion(
            sessionId,
            rel,
            position.lineNumber,
            position.column,
            skip ? '' : model.getValue(),
            tk,
            tc,
            skip,
          );
          if (lspCancelled(token)) {
            return { suggestions: [] };
          }
          if (!res.ok) {
            return { suggestions: [] };
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          const suggestions: Monaco.languages.CompletionItem[] = [];
          const SnippetRule = api.languages.CompletionItemInsertTextRule.InsertAsSnippet;
          for (const it of res.items) {
            const insertText = it.textEdit ? it.textEdit.newText : (it.insertText ?? it.label);
            const item = {
              label: it.label,
              kind: (it.kind ?? api.languages.CompletionItemKind.Text) as Monaco.languages.CompletionItemKind,
              detail: it.detail,
              insertText,
              filterText: it.filterText,
              sortText: it.sortText,
            } as Monaco.languages.CompletionItem;
            const doc = it.documentation;
            if (typeof doc === 'string') {
              item.documentation = doc;
            } else if (doc && typeof doc === 'object' && 'value' in doc) {
              item.documentation = { value: String(doc.value), isTrusted: true };
            }
            if (it.textEdit) {
              item.range = wireRange(api, it.textEdit.range);
              item.insertText = it.textEdit.newText;
            } else if (it.insertTextFormat === 2) {
              item.insertTextRules = SnippetRule;
            }
            if (it.additionalTextEdits?.length) {
              item.additionalTextEdits = it.additionalTextEdits.map((e) => ({
                range: wireRange(api, e.range),
                text: e.newText,
              }));
            }
            suggestions.push(item);
          }
          return { incomplete: res.isIncomplete, suggestions };
        },
      }),
    );

    disposables.push(
      api.languages.registerDocumentSymbolProvider(lang, {
        provideDocumentSymbols: async (model, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorDocumentSymbols(sid, rel, text, skip),
          );
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          if (res.hierarchical?.length) {
            const mapSym = (s: (typeof res.hierarchical)[0]): Monaco.languages.DocumentSymbol => ({
              name: s.name,
              kind: (s.kind ?? api.languages.SymbolKind.File) as Monaco.languages.SymbolKind,
              detail: s.detail ?? '',
              tags: [],
              range: wireRange(api, s.range),
              selectionRange: wireRange(api, s.selectionRange),
              ...(s.children?.length ? { children: s.children.map(mapSym) } : {}),
            });
            return res.hierarchical.map(mapSym);
          }
          return res.flat.map((f) => ({
            name: f.name,
            kind: (f.kind ?? api.languages.SymbolKind.File) as Monaco.languages.SymbolKind,
            detail: f.containerName ? `in ${f.containerName}` : '',
            tags: [],
            range: wireRange(api, f.range),
            selectionRange: wireRange(api, f.range),
          }));
        },
      }),
    );

    disposables.push(
      api.languages.registerRenameProvider(lang, {
        provideRenameEdits: async (model, position, newName, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorRename(sid, rel, position.lineNumber, position.column, text, newName, skip),
          );
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok || !res.workspaceEdit) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          return mapWorkspaceEdit(api, res.workspaceEdit);
        },
      }),
    );

    disposables.push(
      api.languages.registerDocumentSemanticTokensProvider(lang, {
        getLegend: () => legendForMonacoLang(lang),
        provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
          if (!canRun(model)) {
            return null;
          }
          const sessionId = getConversationId()?.trim();
          const rel = getWorkspaceRelativePathForModel(model);
          if (!sessionId || !rel) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const skip = !neededSync;
          const res = await electron.lspEditorSemanticTokensFull(sessionId, rel, skip ? '' : model.getValue(), skip);
          if (lspCancelled(token)) {
            return null;
          }
          if (!res.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          const p = res.payload;
          const sk = lspServerKindForWorkspaceRelativePath(rel);
          if (sk) {
            legends[sk] = {
              tokenTypes: [...p.legend.tokenTypes],
              tokenModifiers: [...p.legend.tokenModifiers],
            };
          }
          const out: Monaco.languages.SemanticTokens = {
            data: new Uint32Array(p.data),
            ...(p.resultId ? { resultId: p.resultId } : {}),
          };
          return out;
        },
        releaseDocumentSemanticTokens: () => {},
      }),
    );
  }

  return {
    dispose: () => {
      for (const d of disposables) {
        d.dispose();
      }
    },
  };
}
