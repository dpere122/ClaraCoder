import type * as Monaco from 'monaco-editor';
import type {
  LspEditorFeature,
  LspEditorFeatureResponse,
  LspWireLocation,
} from '@shared/lsp-editor-features';
import { LSP_EXTENDED_FEATURE_MONACO_LANGUAGE_IDS, lspServerIdForMonacoLanguageId } from '@shared/index';
import type { ElectronService } from '../../../core/electron.service';
import { normalizePathSlashes } from '../../../utils/workspace-relative-path';
import {
  invalidateMonacoModelLspDocumentSync,
  markMonacoModelLspDocumentSynced,
  monacoModelNeedsLspDocumentSync,
} from './workspace-monaco-lsp-sync-state';
import { workspaceFileUri } from './workspace-monaco-workspace-edit';

/** Files previewed per peek; past this the list still shows them, without a preview. */
const MAX_PEEK_PREVIEW_FILES = 30;
const WORKSPACE_SYMBOL_DEBOUNCE_MS = 200;
const LANGUAGE_PRECONDITION = LSP_EXTENDED_FEATURE_MONACO_LANGUAGE_IDS.map((id) => `editorLangId == ${id}`).join(' || ');

export interface LspLocationNavigate {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  /** Set for a read-only page outside the workspace; ``relativePath`` is then that same path. */
  readonly absolutePath?: string;
}

export interface RegisterExtendedLspFeaturesOptions {
  readonly monacoApi: typeof Monaco;
  readonly electron: ElectronService;
  readonly getLspSessionId: () => string | null;
  readonly getWorkspaceRoot: () => string;
  readonly getWorkspaceRelativePathForModel: (model: Monaco.editor.ITextModel) => string | undefined;
  readonly isStoreModel: (model: Monaco.editor.ITextModel) => boolean;
  readonly languageIdForPath: (path: string) => string;
  readonly getEditor: () => Monaco.editor.IStandaloneCodeEditor | null;
  readonly onNavigate: (payload: LspLocationNavigate) => void;
}

/** The server's own words from an error that came through the HTTP route and the LSP client. */
export function lspErrorMessage(raw: string): string {
  let message = raw;
  try {
    const detail = (JSON.parse(raw) as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      message = detail;
    }
  } catch {
    // Not a JSON error body.
  }
  return message.replace(/^LSP request failed for '[^']*': /, '');
}

function range(api: typeof Monaco, r: LspWireLocation['range']): Monaco.Range {
  return new api.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn);
}

/** URI of a location: a workspace file, or a read-only page outside the workspace. */
export function lspLocationUri(api: typeof Monaco, loc: LspWireLocation): Monaco.Uri {
  return loc.externalPath
    ? api.Uri.parse(`clara-external:///${encodeURI(normalizePathSlashes(loc.externalPath))}`)
    : workspaceFileUri(api, normalizePathSlashes(loc.relativePath));
}

export function lspLocationToMonaco(api: typeof Monaco, loc: LspWireLocation): Monaco.languages.Location {
  return { uri: lspLocationUri(api, loc), range: range(api, loc.range) };
}

function navigatePayload(loc: LspWireLocation): LspLocationNavigate {
  const line = loc.range.startLineNumber;
  const column = loc.range.startColumn;
  return loc.externalPath
    ? { relativePath: normalizePathSlashes(loc.externalPath), absolutePath: loc.externalPath, line, column }
    : { relativePath: normalizePathSlashes(loc.relativePath), line, column };
}

type CommandService = { executeCommand: (id: string, ...args: unknown[]) => Promise<unknown> };

async function monacoCommandService(): Promise<CommandService | null> {
  try {
    const [services, commands] = await Promise.all([
      import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'),
      import('monaco-editor/esm/vs/platform/commands/common/commands.js'),
    ]);
    return services.StandaloneServices.get(commands.ICommandService) as CommandService;
  } catch (err) {
    console.warn('[workspace-monaco-lsp-features] command service unavailable', err);
    return null;
  }
}

interface QuickPickItem {
  label: string;
  description?: string;
  location: LspWireLocation;
}

interface QuickPick {
  placeholder?: string;
  items: readonly QuickPickItem[];
  activeItems: readonly QuickPickItem[];
  busy: boolean;
  matchOnDescription: boolean;
  readonly value: string;
  onDidChangeValue: (cb: (value: string) => void) => Monaco.IDisposable;
  onDidAccept: (cb: () => void) => Monaco.IDisposable;
  onDidHide: (cb: () => void) => Monaco.IDisposable;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

async function monacoQuickPick(): Promise<QuickPick | null> {
  try {
    const [services, quickInput] = await Promise.all([
      import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'),
      import('monaco-editor/esm/vs/platform/quickinput/common/quickInput.js'),
    ]);
    const service = services.StandaloneServices.get(quickInput.IQuickInputService) as {
      createQuickPick: () => QuickPick;
    };
    return service.createQuickPick();
  } catch (err) {
    console.warn('[workspace-monaco-lsp-features] quick input unavailable', err);
    return null;
  }
}

/**
 * LSP features with Monaco providers or editor actions, for the languages in
 * ``LSP_EXTENDED_FEATURE_MONACO_LANGUAGE_IDS``.
 */
export function registerExtendedLspFeatures(opts: RegisterExtendedLspFeaturesOptions): {
  readonly disposable: Monaco.IDisposable;
  /** Gives peek widgets a model to preview: Monaco shows no preview for a file with none. */
  readonly ensurePeekModels: (locations: readonly LspWireLocation[]) => Promise<void>;
  /** Runs a feature, re-sending the buffer if the server stopped holding the editor's text. */
  readonly call: <F extends LspEditorFeature>(
    model: Monaco.editor.ITextModel,
    feature: F,
    params?: Record<string, unknown>,
  ) => Promise<LspEditorFeatureResponse<F> | null>;
} {
  const {
    monacoApi: api,
    electron,
    getLspSessionId,
    getWorkspaceRoot,
    getWorkspaceRelativePathForModel,
    isStoreModel,
    languageIdForPath,
    getEditor,
    onNavigate,
  } = opts;
  const disposables: Monaco.IDisposable[] = [];
  let peekModels: Monaco.editor.ITextModel[] = [];

  const call = async <F extends LspEditorFeature>(
    model: Monaco.editor.ITextModel,
    feature: F,
    params: Record<string, unknown> = {},
  ): Promise<LspEditorFeatureResponse<F> | null> => {
    const sid = getLspSessionId()?.trim();
    const rel = getWorkspaceRelativePathForModel(model);
    if (!electron.isElectron || !sid || !rel) {
      return null;
    }
    const neededSync = monacoModelNeedsLspDocumentSync(model);
    let sentVersion: number | null = neededSync ? model.getAlternativeVersionId() : null;
    let res = await electron.lspEditorFeature(sid, rel, feature, params, neededSync ? model.getValue() : '', !neededSync);
    if (res.ok && res.syncedFromDisk && !neededSync) {
      invalidateMonacoModelLspDocumentSync(model);
      sentVersion = model.getAlternativeVersionId();
      res = await electron.lspEditorFeature(sid, rel, feature, params, model.getValue(), false);
    }
    if (res.ok && sentVersion !== null) {
      markMonacoModelLspDocumentSynced(model, sentVersion);
    }
    return res;
  };

  const ensurePeekModels = async (locations: readonly LspWireLocation[]): Promise<void> => {
    for (const model of peekModels) {
      if (!model.isDisposed() && !isStoreModel(model)) {
        model.dispose();
      }
    }
    peekModels = [];
    const seen = new Set<string>();
    for (const loc of locations) {
      const uri = lspLocationUri(api, loc);
      const key = uri.toString();
      if (seen.has(key) || seen.size >= MAX_PEEK_PREVIEW_FILES) {
        continue;
      }
      seen.add(key);
      if (api.editor.getModel(uri)) {
        continue;
      }
      const read = loc.externalPath
        ? await electron.readAbsoluteFile(loc.externalPath)
        : await electron.readWorkspaceFile(getWorkspaceRoot(), loc.relativePath);
      // The tab may have opened this file while the read was in flight.
      if (read.ok && read.content !== undefined && !api.editor.getModel(uri)) {
        const path = loc.externalPath ?? loc.relativePath;
        peekModels.push(api.editor.createModel(read.content, languageIdForPath(path), uri));
      }
    }
  };

  const showMessage = (editor: Monaco.editor.ICodeEditor, text: string): void => {
    const controller = editor.getContribution('editor.contrib.messageController') as {
      showMessage?: (message: string, position: Monaco.IPosition) => void;
    } | null;
    const position = editor.getPosition();
    if (controller?.showMessage && position) {
      controller.showMessage(text, position);
    }
  };

  const peekOrNavigate = async (
    editor: Monaco.editor.ICodeEditor,
    locations: readonly LspWireLocation[],
    emptyMessage: string,
  ): Promise<void> => {
    if (!locations.length) {
      showMessage(editor, emptyMessage);
      return;
    }
    if (locations.length === 1) {
      onNavigate(navigatePayload(locations[0]!));
      return;
    }
    const model = editor.getModel();
    const position = editor.getPosition();
    const commands = await monacoCommandService();
    if (!model || !position || !commands) {
      onNavigate(navigatePayload(locations[0]!));
      return;
    }
    await ensurePeekModels(locations);
    await commands.executeCommand(
      'editor.action.peekLocations',
      model.uri,
      position,
      locations.map((loc) => lspLocationToMonaco(api, loc)),
      'peek',
    );
  };

  const hierarchyAction = (
    id: string,
    label: string,
    feature: 'callHierarchy' | 'typeHierarchy',
    direction: string,
    emptyMessage: string,
    order: number,
  ): void => {
    disposables.push(
      api.editor.addEditorAction({
        id,
        label,
        precondition: LANGUAGE_PRECONDITION,
        contextMenuGroupId: 'navigation',
        contextMenuOrder: order,
        run: async (editor) => {
          const model = editor.getModel();
          const position = editor.getPosition();
          if (!model || !position) {
            return;
          }
          const res = await call(model, feature, {
            line: position.lineNumber,
            character: position.column,
            direction,
          });
          if (!res) {
            return;
          }
          if (!res.ok) {
            showMessage(editor, lspErrorMessage(res.error));
            return;
          }
          await peekOrNavigate(editor, res.result.locations, emptyMessage);
        },
      }),
    );
  };

  hierarchyAction('clara.gdscript.incomingCalls', 'Show Callers', 'callHierarchy', 'incoming', 'No callers found', 1.7);
  hierarchyAction('clara.gdscript.outgoingCalls', 'Show Callees', 'callHierarchy', 'outgoing', 'No callees found', 1.71);
  hierarchyAction('clara.gdscript.supertypes', 'Show Supertypes', 'typeHierarchy', 'supertypes', 'No supertypes found', 1.72);
  hierarchyAction('clara.gdscript.subtypes', 'Show Subtypes', 'typeHierarchy', 'subtypes', 'No subtypes found', 1.73);

  const openWorkspaceSymbolPicker = async (monacoLanguageId: string): Promise<void> => {
    const sid = getLspSessionId()?.trim();
    const server = lspServerIdForMonacoLanguageId(monacoLanguageId);
    if (!sid || !server) {
      return;
    }
    const pick = await monacoQuickPick();
    if (!pick) {
      return;
    }
    pick.placeholder = 'Go to symbol in workspace';
    pick.matchOnDescription = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let requestId = 0;
    const search = (query: string): void => {
      const id = ++requestId;
      pick.busy = true;
      void electron.lspWorkspaceSymbols(sid, server, query).then((res) => {
        if (id !== requestId) {
          return;
        }
        pick.busy = false;
        pick.items = res.ok
          ? res.symbols.map((symbol) => ({
              label: symbol.name ?? '',
              description: [symbol.containerName, symbol.externalPath ?? symbol.relativePath]
                .filter(Boolean)
                .join(' · '),
              location: symbol,
            }))
          : [];
      });
    };
    const subscriptions = [
      pick.onDidChangeValue((value) => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => search(value), WORKSPACE_SYMBOL_DEBOUNCE_MS);
      }),
      pick.onDidAccept(() => {
        const chosen = pick.activeItems[0];
        pick.hide();
        if (chosen) {
          onNavigate(navigatePayload(chosen.location));
        }
      }),
      pick.onDidHide(() => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        requestId++;
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
        pick.dispose();
      }),
    ];
    pick.show();
    search('');
  };

  disposables.push(
    api.editor.addEditorAction({
      id: 'clara.gdscript.workspaceSymbols',
      label: 'Go to Symbol in Workspace...',
      precondition: LANGUAGE_PRECONDITION,
      keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.KeyT],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.74,
      run: (editor) => {
        const language = editor.getModel()?.getLanguageId();
        return language ? openWorkspaceSymbolPicker(language) : undefined;
      },
    }),
  );

  for (const lang of LSP_EXTENDED_FEATURE_MONACO_LANGUAGE_IDS) {
    const navigation = async (
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      feature: 'implementation' | 'typeDefinition' | 'declaration',
    ): Promise<Monaco.languages.Location[] | null> => {
      const res = await call(model, feature, { line: position.lineNumber, character: position.column });
      if (!res?.ok || !res.result.locations.length) {
        return null;
      }
      // Several results open in a peek widget, which previews from a model.
      if (res.result.locations.length > 1) {
        await ensurePeekModels(res.result.locations);
      }
      return res.result.locations.map((loc) => lspLocationToMonaco(api, loc));
    };

    disposables.push(
      api.languages.registerImplementationProvider(lang, {
        provideImplementation: (model, position) => navigation(model, position, 'implementation'),
      }),
      api.languages.registerTypeDefinitionProvider(lang, {
        provideTypeDefinition: (model, position) => navigation(model, position, 'typeDefinition'),
      }),
      api.languages.registerDeclarationProvider(lang, {
        provideDeclaration: (model, position) => navigation(model, position, 'declaration'),
      }),
      api.languages.registerFoldingRangeProvider(lang, {
        provideFoldingRanges: async (model) => {
          const res = await call(model, 'foldingRanges');
          if (!res?.ok) {
            return null;
          }
          const K = api.languages.FoldingRangeKind;
          return res.result.ranges.map((r) => ({
            start: r.start,
            end: r.end,
            kind: r.kind === 'comment' ? K.Comment : r.kind === 'region' ? K.Region : r.kind === 'imports' ? K.Imports : undefined,
          }));
        },
      }),
      api.languages.registerSelectionRangeProvider(lang, {
        provideSelectionRanges: async (model, positions) => {
          const res = await call(model, 'selectionRanges', {
            positions: positions.map((p) => ({ lineNumber: p.lineNumber, column: p.column })),
          });
          if (!res?.ok || res.result.selections.length !== positions.length) {
            return [];
          }
          return res.result.selections.map((chain) => chain.map((r) => ({ range: range(api, r) })));
        },
      }),
      api.languages.registerColorProvider(lang, {
        provideDocumentColors: async (model) => {
          const res = await call(model, 'documentColors');
          return res?.ok ? res.result.colors.map((c) => ({ color: c.color, range: range(api, c.range) })) : [];
        },
        provideColorPresentations: async (model, info) => {
          const res = await call(model, 'colorPresentations', {
            color: info.color,
            start_line: info.range.startLineNumber,
            start_character: info.range.startColumn,
            end_line: info.range.endLineNumber,
            end_character: info.range.endColumn,
          });
          if (!res?.ok) {
            return [];
          }
          return res.result.presentations.map((p) => ({
            label: p.label,
            ...(p.textEdit ? { textEdit: { range: range(api, p.textEdit.range), text: p.textEdit.newText } } : {}),
          }));
        },
      }),
      api.languages.registerLinkProvider(lang, {
        provideLinks: async (model) => {
          const res = await call(model, 'documentLinks');
          const links: Monaco.languages.ILink[] = [];
          for (const link of res?.ok ? res.result.links : []) {
            const url = link.relativePath ? workspaceFileUri(api, normalizePathSlashes(link.relativePath)) : link.url;
            if (url) {
              links.push({ range: range(api, link.range), url, tooltip: link.tooltip });
            }
          }
          return { links };
        },
      }),
    );
  }

  return {
    disposable: {
      dispose: () => {
        for (const d of disposables) {
          d.dispose();
        }
      },
    },
    ensurePeekModels,
    call,
  };
}
