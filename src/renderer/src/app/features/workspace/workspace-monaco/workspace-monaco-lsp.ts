import type * as Monaco from 'monaco-editor';
import type { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import type { LspEditorDiagnostic, LspWireInlayHint } from '@shared/index';
import {
  LSP_EXTENDED_FEATURE_MONACO_LANGUAGE_IDS,
  LSP_MONACO_LANGUAGE_IDS,
  lspServerIdForMonacoLanguageId,
  lspServerKindForWorkspaceRelativePath,
} from '@shared/index';
import { invalidateMonacoModelLspDocumentSync, markMonacoModelLspDocumentSynced, monacoModelNeedsLspDocumentSync } from './workspace-monaco-lsp-sync-state';
import { registerJavaShowLocationCommands } from './workspace-monaco-java-code-lens';
import { lspErrorMessage, lspLocationToMonaco, registerExtendedLspFeatures } from './workspace-monaco-lsp-features';
import { workspaceFileUri, writeEditsForClosedFiles } from './workspace-monaco-workspace-edit';

const GDSCRIPT_COMPLETION_TRIGGERS = ['.', '$', '%', '"', '@'];
/** The trigger characters rust-analyzer registers: paths (``::``), members, lifetimes and call arguments. */
const RUST_COMPLETION_TRIGGERS = ['.', ':', "'", '('];

export interface WorkspaceMonacoLspNavigatePayload {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  /** Set for a read-only page outside the workspace; ``relativePath`` is then that same path. */
  readonly absolutePath?: string;
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
  readonly getWorkspaceRoot: () => string;
  /** Whether the model store owns this model (peek previews create their own). */
  readonly isStoreModel: (model: Monaco.editor.ITextModel) => boolean;
  readonly languageIdForPath: (path: string) => string;
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

type LspBackedInlayHint = Monaco.languages.InlayHint & { lspHint?: Record<string, unknown> };

/** Copies what may arrive with the hint or only on resolve. */
function applyInlayHintDetails(api: typeof Monaco, hint: LspBackedInlayHint, wire: LspWireInlayHint): void {
  const tip = wire.tooltip;
  if (typeof tip === 'string') {
    hint.tooltip = tip;
  } else if (tip && typeof tip === 'object' && 'value' in tip) {
    hint.tooltip = { value: String(tip.value), isTrusted: true };
  }
  if (wire.textEdits?.length) {
    hint.textEdits = wire.textEdits.map((e) => ({ range: wireRange(api, e.range), text: e.newText }));
  }
  if (wire.lspHint) {
    hint.lspHint = wire.lspHint;
  }
}

function lspCancelled(token: Monaco.CancellationToken | undefined): boolean {
  return token?.isCancellationRequested === true;
}

/**
 * Registers workspace-scoped LSP providers on the standalone editor.
 * Models must use the ``clara-workspace`` URI scheme (see ``WorkspaceMonacoComponent``).
 */
/** A Monaco ``IEvent<void>`` source; ``monaco.Emitter`` would tie this to the loaded editor module. */
function createVoidEvent(): { event: Monaco.IEvent<void>; fire: () => void; dispose: () => void } {
  const listeners = new Set<() => void>();
  return {
    event: (listener, thisArgs?: unknown) => {
      const bound = () => listener.call(thisArgs, undefined);
      listeners.add(bound);
      return { dispose: () => listeners.delete(bound) };
    },
    fire: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    dispose: () => listeners.clear(),
  };
}

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
    getWorkspaceRoot,
    isStoreModel,
    languageIdForPath,
  } = opts;
  const disposables: Monaco.IDisposable[] = [];
  const extended = registerExtendedLspFeatures({
    monacoApi: api,
    electron,
    getLspSessionId,
    getWorkspaceRoot,
    getWorkspaceRelativePathForModel,
    isStoreModel,
    languageIdForPath,
    getEditor,
    onNavigate: onNavigateToWorkspaceFile,
  });
  disposables.push(extended.disposable);

  // Settings → Apply restarts a server whose settings changed. Monaco only asks for inlay hints
  // again when the text changes, so open editors would keep the old hints; ask now instead.
  const inlayHintsChanged = createVoidEvent();
  disposables.push(inlayHintsChanged);
  const stopSettingsWatch =
    electron.onLspSettingsApplied?.((servers) => {
      const restarted = new Set(servers);
      for (const model of api.editor.getModels()) {
        const rel = getWorkspaceRelativePathForModel(model);
        const server = rel ? lspServerKindForWorkspaceRelativePath(rel) : null;
        if (server && restarted.has(server)) {
          // The new server has never seen this buffer, which may hold unsaved edits.
          invalidateMonacoModelLspDocumentSync(model);
        }
      }
      if (servers.length > 0) {
        inlayHintsChanged.fire();
      }
    }) ?? (() => {});
  disposables.push({ dispose: stopSettingsWatch });

  disposables.push(
    registerJavaShowLocationCommands({
      monacoApi: api,
      getEditor,
      onNavigateToWorkspaceFile,
    }),
  );

  disposables.push(
    api.editor.registerEditorOpener({
      openCodeEditor: (source, resource, selectionOrPosition) => {
        const external = resource.scheme === 'clara-external';
        if (resource.scheme !== 'clara-workspace' && !external) {
          return false;
        }
        // Monaco's peek command first "opens" the file it starts from, with no position. Treating
        // that as a navigation would send the caret to line 1 underneath the peek.
        if (!selectionOrPosition && source.getModel()?.uri.toString() === resource.toString()) {
          return true;
        }
        // Only the URI's own separator goes: a POSIX absolute path keeps its leading slash.
        const rel = external ? decodeURI(resource.path.slice(1)) : decodeURI(resource.path.replace(/^\/+/, ''));
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
        onNavigateToWorkspaceFile({ relativePath: rel, line, column, ...(external ? { absolutePath: rel } : {}) });
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
    const extendedFeatures = LSP_EXTENDED_FEATURE_MONACO_LANGUAGE_IDS.includes(lang);

    disposables.push(
      api.languages.registerDefinitionProvider(lang, {
        provideDefinition: async (model, position, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          let sentVersion: number | null = neededSync ? model.getAlternativeVersionId() : null;
          let res = await withSessionAndDocument(model, (sid, rel, text, skipSync) =>
            electron.lspEditorDefinition(sid, rel, position.lineNumber, position.column, text, skipSync),
          );
          if (res && res.ok && res.syncedFromDisk && !neededSync) {
            invalidateMonacoModelLspDocumentSync(model);
            const sid = getLspSessionId()?.trim();
            const rel = getWorkspaceRelativePathForModel(model);
            if (sid && rel) {
              sentVersion = model.getAlternativeVersionId();
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
          if (res?.ok && sentVersion !== null) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok || !res.locations?.length) {
            return null;
          }
          return res.locations.map((loc) => lspLocationToMonaco(api, loc));
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
          const sentVersion = model.getAlternativeVersionId();
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorReferences(sid, rel, position.lineNumber, position.column, text, context.includeDeclaration, skip),
          );
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok || !res.locations?.length) {
            return null;
          }
          // References open in a peek widget, which previews from a model.
          if (extendedFeatures) {
            await extended.ensurePeekModels(res.locations);
          }
          return res.locations.map((loc) => lspLocationToMonaco(api, loc));
        },
      }),
    );

    disposables.push(
      api.languages.registerCompletionItemProvider(lang, {
        triggerCharacters:
          lang === 'java'
            ? ['.', '@', '#', '*', ' ']
            : lang === 'gdscript'
              ? GDSCRIPT_COMPLETION_TRIGGERS
              : lang === 'rust'
                ? RUST_COMPLETION_TRIGGERS
                : ['.', '/', '"', "'", '`', '@', '<', '#'],
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
          let sentVersion: number | null = neededSync ? model.getAlternativeVersionId() : null;
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
            sentVersion = model.getAlternativeVersionId();
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
          if (completionRes.ok && sentVersion !== null) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token)) {
            return { suggestions: [] };
          }
          if (!completionRes.ok) {
            return { suggestions: [] };
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
          const sentVersion = model.getAlternativeVersionId();
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorDocumentSymbols(sid, rel, text, skip),
          );
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok) {
            return null;
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
          const sentVersion = model.getAlternativeVersionId();
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorRename(sid, rel, position.lineNumber, position.column, text, newName, skip),
          );
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token)) {
            return null;
          }
          if (!res || !res.ok || !res.workspaceEdit) {
            return null;
          }
          // Monaco can only edit open models; a multi-file rename also touches closed files.
          const { openChanges, error } = await writeEditsForClosedFiles(
            (relativePath) => {
              const open = api.editor.getModel(workspaceFileUri(api, relativePath));
              return !!open && isStoreModel(open);
            },
            electron,
            getWorkspaceRoot(),
            res.workspaceEdit.changes,
          );
          if (error) {
            return { edits: [], rejectReason: error };
          }
          return mapWorkspaceEdit(api, { changes: openChanges });
        },
        ...(extendedFeatures
          ? {
              resolveRenameLocation: async (
                model: Monaco.editor.ITextModel,
                position: Monaco.Position,
                token: Monaco.CancellationToken,
              ): Promise<Monaco.languages.RenameLocation & Monaco.languages.Rejection> => {
                const word = model.getWordAtPosition(position);
                const fallback = {
                  range: new api.Range(
                    position.lineNumber,
                    word?.startColumn ?? position.column,
                    position.lineNumber,
                    word?.endColumn ?? position.column,
                  ),
                  text: word?.word ?? '',
                };
                const res = await extended.call(model, 'prepareRename', {
                  line: position.lineNumber,
                  character: position.column,
                });
                if (lspCancelled(token) || !res) {
                  return fallback;
                }
                // gdls refuses names it can't safely rewrite, such as engine symbols.
                if (!res.ok) {
                  return { ...fallback, rejectReason: lspErrorMessage(res.error) };
                }
                const { range, placeholder, defaultBehavior } = res.result;
                if (defaultBehavior) {
                  return fallback;
                }
                if (!range) {
                  return { ...fallback, rejectReason: 'This element cannot be renamed.' };
                }
                return { range: wireRange(api, range), text: placeholder ?? model.getValueInRange(range) };
              },
            }
          : {}),
      }),
    );

    disposables.push(
      api.languages.registerDocumentSemanticTokensProvider(lang, {
        getLegend: () => legendForMonacoLang(lang),
        provideDocumentSemanticTokens: async (model, lastResultId, token) => {
          if (!canRun(model)) {
            return null;
          }
          const sessionId = getLspSessionId()?.trim();
          const rel = getWorkspaceRelativePathForModel(model);
          if (!sessionId || !rel) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const sentVersion = model.getAlternativeVersionId();
          const skip = !neededSync;
          if (extendedFeatures && lastResultId) {
            const delta = await electron.lspEditorSemanticTokensDelta(
              sessionId,
              rel,
              lastResultId,
              skip ? '' : model.getValue(),
              skip,
            );
            if (lspCancelled(token)) {
              return null;
            }
            // Falls through to a full request when the server no longer has that result.
            if (delta.ok) {
              if (neededSync) {
                markMonacoModelLspDocumentSynced(model, sentVersion);
              }
              const { resultId, edits, data } = delta.payload;
              if (Array.isArray(data)) {
                return { data: new Uint32Array(data), ...(resultId ? { resultId } : {}) };
              }
              return {
                ...(resultId ? { resultId } : {}),
                edits: (edits as Array<{ start: number; deleteCount: number; data?: number[] }>).map((e) => ({
                  start: e.start,
                  deleteCount: e.deleteCount,
                  ...(e.data ? { data: new Uint32Array(e.data) } : {}),
                })),
              };
            }
          }
          const res = await electron.lspEditorSemanticTokensFull(sessionId, rel, skip ? '' : model.getValue(), skip);
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token)) {
            return null;
          }
          if (!res.ok) {
            return null;
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

    if (extendedFeatures) {
      disposables.push(
        api.languages.registerDocumentRangeSemanticTokensProvider(lang, {
          getLegend: () => legendForMonacoLang(lang),
          provideDocumentRangeSemanticTokens: async (model, range, token) => {
            const res = await extended.call(model, 'semanticTokensRange', {
              start_line: range.startLineNumber,
              start_character: range.startColumn,
              end_line: range.endLineNumber,
              end_character: range.endColumn,
            });
            if (lspCancelled(token) || !res?.ok) {
              return null;
            }
            return { data: new Uint32Array(res.result.payload.data) };
          },
        }),
      );
    }

    disposables.push(
      api.languages.registerSignatureHelpProvider(lang, {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [')'],
          provideSignatureHelp: async (model, position, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const sentVersion = model.getAlternativeVersionId();
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
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok || !res.signatureHelp) {
            return null;
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
          const sentVersion = model.getAlternativeVersionId();
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorDocumentHighlight(sid, rel, position.lineNumber, position.column, text, skip),
          );
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok) {
            return null;
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
          const sentVersion = model.getAlternativeVersionId();
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
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok) {
            return { actions: [], dispose: () => {} };
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
          const sentVersion = model.getAlternativeVersionId();
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
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok) {
            return null;
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
          const sentVersion = model.getAlternativeVersionId();
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
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok) {
            return null;
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
          const sentVersion = model.getAlternativeVersionId();
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
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok) {
            return null;
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
        onDidChangeInlayHints: inlayHintsChanged.event,
        provideInlayHints: async (model, range, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const sentVersion = model.getAlternativeVersionId();
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
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok) {
            return null;
          }
          const hints: Monaco.languages.InlayHint[] = (res.hints ?? []).map((h) => {
            const hint: Monaco.languages.InlayHint = {
              position: new api.Position(h.position.lineNumber, h.position.column),
              label: h.label,
              kind: h.kind as Monaco.languages.InlayHintKind | undefined,
              paddingLeft: h.paddingLeft,
              paddingRight: h.paddingRight,
            };
            applyInlayHintDetails(api, hint, h);
            return hint;
          });
          return { hints, dispose: () => {} };
        },
        ...(extendedFeatures
          ? {
              resolveInlayHint: async (hint: LspBackedInlayHint, token: Monaco.CancellationToken) => {
                const model = getEditor()?.getModel();
                if (!hint.lspHint || !model || !canRun(model)) {
                  return hint;
                }
                const res = await extended.call(model, 'inlayHintResolve', { hint: hint.lspHint });
                if (lspCancelled(token) || !res?.ok || !res.result.hint) {
                  return hint;
                }
                applyInlayHintDetails(api, hint, res.result.hint);
                return hint;
              },
            }
          : {}),
      }),
    );

    disposables.push(
      api.languages.registerCodeLensProvider(lang, {
        provideCodeLenses: async (model, token) => {
          if (!canRun(model)) {
            return null;
          }
          const neededSync = monacoModelNeedsLspDocumentSync(model);
          const sentVersion = model.getAlternativeVersionId();
          const res = await withSessionAndDocument(model, (sid, rel, text, skip) =>
            electron.lspEditorCodeLens(sid, rel, text, skip),
          );
          if (neededSync && res?.ok) {
            markMonacoModelLspDocumentSynced(model, sentVersion);
          }
          if (lspCancelled(token) || !res?.ok) {
            return null;
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
