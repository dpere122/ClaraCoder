import type * as Monaco from 'monaco-editor';
import type { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import type { LspEditorDiagnostic } from '@shared/index';
import {
  LSP_MONACO_LANGUAGE_IDS,
  lspServerIdForMonacoLanguageId,
  lspServerKindForWorkspaceRelativePath,
} from '@shared/index';
import { invalidateMonacoModelLspDocumentSync, markMonacoModelLspDocumentSynced, monacoModelNeedsLspDocumentSync } from './workspace-monaco-lsp-sync-state';
import { registerJavaShowLocationCommands } from './workspace-monaco-java-code-lens';

export interface WorkspaceMonacoLspNavigatePayload {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
}

export interface RegisterWorkspaceMonacoLspOptions {
  readonly monacoApi: typeof Monaco;
  readonly electron: ElectronService;
  /** LSP session id (conversation id or workspace fallback). */
  readonly getLspSessionId: () => string | null;
  readonly getConversationId: () => string | null;
  /** Resolve workspace-relative POSIX path for a ``clara-workspace`` model, or ``undefined``. */
  readonly getWorkspaceRelativePathForModel: (model: Monaco.editor.ITextModel) => string | undefined;
  /** Cached diagnostics for the active model (code actions). */
  readonly getDiagnosticsForModel: (model: Monaco.editor.ITextModel) => readonly LspEditorDiagnostic[];
  readonly getEditorTabSettings: () => { tabSize: number; insertSpaces: boolean; formatOnSave: boolean };
  /** Cross-file go-to-definition / reveal cursor after tab switch. */
  readonly onNavigateToWorkspaceFile: (payload: WorkspaceMonacoLspNavigatePayload) => void;
  /** Prefetched from ``GET /lsp/semantic-tokens-legend`` so ``getLegend()`` is valid on first paint. */
  readonly semanticLegendsByServer?: Record<string, Monaco.languages.SemanticTokensLegend>;
  readonly getEditor: () => Monaco.editor.IStandaloneCodeEditor | null;
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

/**
 * LSP ``CompletionItemKind`` is 1-based with a different order than Monaco's enum.
 * Passing the LSP integer through as Monaco kind makes IconLabel look up the wrong
 * (sometimes missing) icon.
 */
function monacoCompletionKindFromLsp(
  api: typeof Monaco,
  lspKind: number | undefined,
): Monaco.languages.CompletionItemKind {
  const K = api.languages.CompletionItemKind;
  switch (lspKind) {
    case 1:
      return K.Text;
    case 2:
      return K.Method;
    case 3:
      return K.Function;
    case 4:
      return K.Constructor;
    case 5:
      return K.Field;
    case 6:
      return K.Variable;
    case 7:
      return K.Class;
    case 8:
      return K.Interface;
    case 9:
      return K.Module;
    case 10:
      return K.Property;
    case 11:
      return K.Unit;
    case 12:
      return K.Value;
    case 13:
      return K.Enum;
    case 14:
      return K.Keyword;
    case 15:
      return K.Snippet;
    case 16:
      return K.Color;
    case 17:
      return K.File;
    case 18:
      return K.Reference;
    case 19:
      return K.Folder;
    case 20:
      return K.EnumMember;
    case 21:
      return K.Constant;
    case 22:
      return K.Struct;
    case 23:
      return K.Event;
    case 24:
      return K.Operator;
    case 25:
      return K.TypeParameter;
    default:
      return K.Text;
  }
}

type LspBackedCompletionItem = Monaco.languages.CompletionItem & {
  data?: unknown;
  lspKind?: number;
};

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
    getLspSessionId,
    getConversationId,
    getWorkspaceRelativePathForModel,
    getDiagnosticsForModel,
    getEditorTabSettings,
    onNavigateToWorkspaceFile,
    semanticLegendsByServer,
    getEditor,
  } = opts;
  const disposables: Monaco.IDisposable[] = [];

  disposables.push(
    registerJavaShowLocationCommands({
      monacoApi: api,
      getEditor,
      onNavigateToWorkspaceFile,
    }),
  );

  disposables.push(
    api.editor.registerEditorOpener({
      openCodeEditor: (_source, resource, selectionOrPosition) => {
        if (resource.scheme !== 'clara-workspace') {
          return false;
        }
        const rel = decodeURI(resource.path.replace(/^\/+/, ''));
        if (!rel) {
          return false;
        }
        let line = 1;
        let column = 1;
        if (selectionOrPosition) {
          if ('startLineNumber' in selectionOrPosition) {
            line = selectionOrPosition.startLineNumber;
            column = selectionOrPosition.startColumn;
          } else if ('lineNumber' in selectionOrPosition) {
            line = selectionOrPosition.lineNumber;
            column = selectionOrPosition.column;
          }
        }
        onNavigateToWorkspaceFile({ relativePath: rel, line, column });
        return true;
      },
    }),
  );

  const legends: Record<string, Monaco.languages.SemanticTokensLegend> = semanticLegendsByServer ?? {};

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
    return !!(rel && lspServerKindForWorkspaceRelativePath(rel) && getLspSessionId()?.trim());
  };

  const sessionId = (): string | null => getLspSessionId()?.trim() ?? null;

  const withSessionAndDocument = <T>(
    model: Monaco.editor.ITextModel,
    fn: (sessionId: string, rel: string, text: string, skipDocumentSync: boolean) => Promise<T>,
  ): Promise<T | null> => {
    const sessionId = getLspSessionId()?.trim();
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
          const skip = !neededSync;
          let res = await withSessionAndDocument(model, (sid, rel, text, skipSync) =>
            electron.lspEditorDefinition(sid, rel, position.lineNumber, position.column, text, skipSync),
          );
          if (res && res.ok && res.syncedFromDisk && skip) {
            invalidateMonacoModelLspDocumentSync(model);
            const sid = getLspSessionId()?.trim();
            const rel = getWorkspaceRelativePathForModel(model);
            if (sid && rel) {
              res = await electron.lspEditorDefinition(
                sid,
                rel,
                position.lineNumber,
                position.column,
                model.getValue(),
                false,
              );
            }
          }
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok || !res.locations?.length) {
            return null;
          }
          if (neededSync || (res.ok && res.syncedFromDisk)) {
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
        triggerCharacters:
          lang === 'java' ? ['.', '@', '#', '*', ' '] : ['.', '/', '"', "'", '`', '@', '<', '#'],
        provideCompletionItems: async (model, position, context, token) => {
          if (!canRun(model)) {
            return { suggestions: [] };
          }
          const sessionId = getLspSessionId()?.trim();
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
          let completionRes = res;
          if (completionRes.ok && completionRes.syncedFromDisk && skip) {
            invalidateMonacoModelLspDocumentSync(model);
            completionRes = await electron.lspEditorCompletion(
              sessionId,
              rel,
              position.lineNumber,
              position.column,
              model.getValue(),
              tk,
              tc,
              false,
            );
          }
          if (lspCancelled(token)) {
            return { suggestions: [] };
          }
          if (!completionRes.ok) {
            return { suggestions: [] };
          }
          if (neededSync || completionRes.syncedFromDisk) {
            markMonacoModelLspDocumentSynced(model);
          }
          const suggestions: Monaco.languages.CompletionItem[] = [];
          const SnippetRule = api.languages.CompletionItemInsertTextRule.InsertAsSnippet;
          const word = model.getWordUntilPosition(position);
          const defaultRange = new api.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          for (const it of completionRes.items) {
            const insertText = it.textEdit ? it.textEdit.newText : (it.insertText ?? it.label);
            const item: LspBackedCompletionItem = {
              label: it.label,
              kind: monacoCompletionKindFromLsp(api, it.kind),
              detail: it.detail,
              insertText,
              filterText: it.filterText,
              sortText: it.sortText,
              range: it.textEdit ? wireRange(api, it.textEdit.range) : defaultRange,
            };
            if (typeof it.kind === 'number') {
              item.lspKind = it.kind;
            }
            if (it.data !== undefined) {
              item.data = it.data;
            }
            const doc = it.documentation;
            if (typeof doc === 'string') {
              item.documentation = doc;
            } else if (doc && typeof doc === 'object' && 'value' in doc) {
              item.documentation = { value: String(doc.value), isTrusted: true };
            }
            if (it.textEdit) {
              item.insertText = it.textEdit.newText;
            }
            if (it.insertTextFormat === 2) {
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
          return { incomplete: completionRes.isIncomplete, suggestions };
        },
        resolveCompletionItem: async (item, token) => {
          if (lspCancelled(token)) {
            return item;
          }
          const model = getEditor()?.getModel();
          const sid = sessionId();
          const rel = model ? getWorkspaceRelativePathForModel(model) : undefined;
          if (!model || !sid || !rel || !canRun(model)) {
            return item;
          }
          const backed = item as LspBackedCompletionItem;
          const resolvePayload: Record<string, unknown> = {
            label: typeof item.label === 'string' ? item.label : String(item.label),
            kind: backed.lspKind ?? item.kind,
            detail: item.detail,
            insertText: item.insertText,
          };
          if (backed.data !== undefined) {
            resolvePayload['data'] = backed.data;
          }
          const res = await electron.lspEditorCompletionResolve(sid, rel, resolvePayload);
          if (!res.ok || !res.item) {
            return item;
          }
          const doc = res.item.documentation;
          if (typeof doc === 'string') {
            item.documentation = doc;
          } else if (doc && typeof doc === 'object' && 'value' in doc) {
            item.documentation = { value: String(doc.value), isTrusted: true };
          }
          if (res.item.detail) {
            item.detail = res.item.detail;
          }
          return item;
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
          const sessionId = getLspSessionId()?.trim();
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

    disposables.push(
      api.languages.registerSignatureHelpProvider(lang, {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [')'],
          provideSignatureHelp: async (model, position, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorSignatureHelp(
              sid,
              rel,
              position.lineNumber,
              position.column,
              text,
              null,
              false,
              skip,
            ),
          );
          if (lspCancelled(token) || !res?.ok || !res.signatureHelp) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          const sh = res.signatureHelp as {
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
          };
          const signatures: Monaco.languages.SignatureInformation[] = sh.signatures.map((s) => {
            const info: Monaco.languages.SignatureInformation = {
              label: s.label,
              parameters: (s.parameters ?? []).map((p) => ({
                label: p.label,
                documentation:
                  typeof p.documentation === 'string'
                    ? p.documentation
                    : p.documentation && typeof p.documentation === 'object' && 'value' in p.documentation
                      ? { value: String(p.documentation.value), isTrusted: true }
                      : undefined,
              })),
            };
            if (typeof s.documentation === 'string') {
              info.documentation = s.documentation;
            } else if (s.documentation && typeof s.documentation === 'object' && 'value' in s.documentation) {
              info.documentation = { value: String(s.documentation.value), isTrusted: true };
            }
            return info;
          });
          return {
            value: {
              signatures,
              activeSignature: sh.activeSignature ?? 0,
              activeParameter: sh.activeParameter ?? 0,
            },
            dispose: () => {},
          };
        },
      }),
    );

    disposables.push(
      api.languages.registerDocumentHighlightProvider(lang, {
        provideDocumentHighlights: async (model, position, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorDocumentHighlight(sid, rel, position.lineNumber, position.column, text, skip),
          );
          if (lspCancelled(token) || !res?.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          return (res.highlights ?? []).map((h) => ({
            range: wireRange(api, h.range),
            kind: (h.kind ?? api.languages.DocumentHighlightKind.Text) as Monaco.languages.DocumentHighlightKind,
          }));
        },
      }),
    );

    disposables.push(
      api.languages.registerCodeActionProvider(lang, {
        provideCodeActions: async (model, range, _context, token) => {
          if (!canRun(model)) {
            return { actions: [], dispose: () => {} };
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const diags = [...getDiagnosticsForModel(model)];
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorCodeAction(
              sid,
              rel,
              range.startLineNumber,
              range.startColumn,
              range.endLineNumber,
              range.endColumn,
              text,
              diags,
              skip,
            ),
          );
          if (lspCancelled(token) || !res?.ok) {
            return { actions: [], dispose: () => {} };
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          const actions: Monaco.languages.CodeAction[] = (res.actions ?? []).map((a) => {
            const action: Monaco.languages.CodeAction = {
              title: a.title,
              kind: a.kind || 'quickfix',
              isPreferred: a.isPreferred,
            };
            if (a.edit) {
              action.edit = mapWorkspaceEdit(api, a.edit);
            }
            return action;
          });
          return { actions, dispose: () => {} };
        },
      }),
    );

    disposables.push(
      api.languages.registerDocumentFormattingEditProvider(lang, {
        provideDocumentFormattingEdits: async (model, options, token) => {
          if (!canRun(model)) {
            return null;
          }
          const tab = getEditorTabSettings();
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorFormatting(
              sid,
              rel,
              text,
              options.tabSize ?? tab.tabSize,
              options.insertSpaces ?? tab.insertSpaces,
              skip,
            ),
          );
          if (lspCancelled(token) || !res?.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          return (res.edits ?? []).map((e) => ({
            range: wireRange(api, e.range),
            text: e.newText,
          }));
        },
      }),
    );

    disposables.push(
      api.languages.registerDocumentRangeFormattingEditProvider(lang, {
        provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
          if (!canRun(model)) {
            return null;
          }
          const tab = getEditorTabSettings();
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorRangeFormatting(
              sid,
              rel,
              range.startLineNumber,
              range.startColumn,
              range.endLineNumber,
              range.endColumn,
              text,
              options.tabSize ?? tab.tabSize,
              options.insertSpaces ?? tab.insertSpaces,
              skip,
            ),
          );
          if (lspCancelled(token) || !res?.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          return (res.edits ?? []).map((e) => ({
            range: wireRange(api, e.range),
            text: e.newText,
          }));
        },
      }),
    );

    disposables.push(
      api.languages.registerOnTypeFormattingEditProvider(lang, {
        autoFormatTriggerCharacters: [';', '}', '\n'],
        provideOnTypeFormattingEdits: async (model, position, ch, _options, token) => {
          if (!canRun(model)) {
            return null;
          }
          const tab = getEditorTabSettings();
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorOnTypeFormatting(
              sid,
              rel,
              position.lineNumber,
              position.column,
              ch,
              text,
              tab.tabSize,
              tab.insertSpaces,
              skip,
            ),
          );
          if (lspCancelled(token) || !res?.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          return (res.edits ?? []).map((e) => ({
            range: wireRange(api, e.range),
            text: e.newText,
          }));
        },
      }),
    );

    disposables.push(
      api.languages.registerInlayHintsProvider(lang, {
        provideInlayHints: async (model, range, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorInlayHints(
              sid,
              rel,
              range.startLineNumber,
              range.startColumn,
              range.endLineNumber,
              range.endColumn,
              text,
              skip,
            ),
          );
          if (lspCancelled(token) || !res?.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          const hints: Monaco.languages.InlayHint[] = (res.hints ?? []).map((h) => {
            const hint: Monaco.languages.InlayHint = {
              position: new api.Position(h.position.lineNumber, h.position.column),
              label: h.label,
              kind: h.kind as Monaco.languages.InlayHintKind | undefined,
              paddingLeft: h.paddingLeft,
              paddingRight: h.paddingRight,
            };
            const tip = h.tooltip;
            if (typeof tip === 'string') {
              hint.tooltip = tip;
            } else if (tip && typeof tip === 'object' && 'value' in tip) {
              hint.tooltip = { value: String(tip.value), isTrusted: true };
            }
            return hint;
          });
          return { hints, dispose: () => {} };
        },
      }),
    );

    disposables.push(
      api.languages.registerCodeLensProvider(lang, {
        provideCodeLenses: async (model, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorCodeLens(sid, rel, text, skip),
          );
          if (lspCancelled(token) || !res?.ok) {
            return null;
          }
          if (neededSync) {
            markMonacoModelLspDocumentSynced(model);
          }
          // Preserve LSP ``data`` on the Monaco lens so resolve can round-trip it.
          // JDT LS requires ``data`` on codeLens/resolve and NPEs when it is null.
          type LspBackedCodeLens = Monaco.languages.CodeLens & { data?: unknown };
          const lenses: LspBackedCodeLens[] = (res.lenses ?? []).map((l) => {
            const lens: LspBackedCodeLens = {
              range: wireRange(api, l.range),
            };
            if (l.command) {
              lens.command = {
                id: l.command.command,
                title: l.command.title,
                arguments: l.command.arguments as unknown[] | undefined,
              };
            }
            if (l.data !== undefined) {
              lens.data = l.data;
            }
            return lens;
          });
          return { lenses, dispose: () => {} };
        },
        resolveCodeLens: async (model, codeLens, token) => {
          if (!canRun(model)) {
            return codeLens;
          }
          if (codeLens.command) {
            return codeLens;
          }
          const sid = sessionId();
          const rel = getWorkspaceRelativePathForModel(model);
          if (!sid || !rel) {
            return codeLens;
          }
          const data = (codeLens as Monaco.languages.CodeLens & { data?: unknown }).data;
          if (data === undefined || data === null) {
            return codeLens;
          }
          const res = await electron.lspEditorCodeLensResolve(sid, rel, {
            range: {
              startLineNumber: codeLens.range.startLineNumber,
              startColumn: codeLens.range.startColumn,
              endLineNumber: codeLens.range.endLineNumber,
              endColumn: codeLens.range.endColumn,
            },
            data,
          });
          if (lspCancelled(token) || !res.ok || !res.lens?.command) {
            return codeLens;
          }
          codeLens.command = {
            id: res.lens.command.command,
            title: res.lens.command.title,
            arguments: res.lens.command.arguments as unknown[] | undefined,
          };
          return codeLens;
        },
      }),
    );
  }

  for (const lang of LSP_MONACO_LANGUAGE_IDS) {
    disposables.push(
      api.languages.registerLinkProvider(lang, {
        provideLinks: (model, token) => {
          if (lspCancelled(token)) {
            return Promise.resolve({ links: [], dispose: () => {} });
          }
          const text = model.getValue();
          const links: Monaco.languages.ILink[] = [];
          const urlRe = /\bhttps?:\/\/[^\s<>")]+/g;
          const fileRe = /\bfile:\/\/[^\s<>")]+/g;
          for (const re of [urlRe, fileRe]) {
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              const start = model.getPositionAt(m.index);
              const end = model.getPositionAt(m.index + m[0].length);
              links.push({
                range: new api.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                url: m[0],
                tooltip: m[0],
              });
            }
          }
          return Promise.resolve({ links, dispose: () => {} });
        },
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
