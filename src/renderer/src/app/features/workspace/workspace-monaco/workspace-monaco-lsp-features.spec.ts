import type * as Monaco from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import type { ElectronService } from '../../../core/electron.service';
import { lspErrorMessage, lspLocationUri, registerExtendedLspFeatures } from './workspace-monaco-lsp-features';

type Provider = Record<string, (...args: never[]) => unknown>;

function fakeApi() {
  const providers = new Map<string, Array<{ language: string; provider: Provider }>>();
  const actions: Array<{ id: string; precondition?: string; run: (editor: unknown) => unknown }> = [];
  const models: Array<{ uri: { value: string }; dispose: () => void; isDisposed: () => boolean }> = [];
  const register = (name: string) =>
    vi.fn((language: string, provider: Provider) => {
      providers.set(name, [...(providers.get(name) ?? []), { language, provider }]);
      return { dispose: vi.fn() };
    });
  const api = {
    Uri: { parse: (value: string) => ({ value, toString: () => value }) },
    Range: class {
      constructor(
        readonly startLineNumber: number,
        readonly startColumn: number,
        readonly endLineNumber: number,
        readonly endColumn: number,
      ) {}
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyT: 50 },
    editor: {
      addEditorAction: vi.fn((action: (typeof actions)[number]) => {
        actions.push(action);
        return { dispose: vi.fn() };
      }),
      getModel: vi.fn((uri: { value: string }) => models.find((m) => m.uri.value === uri.value) ?? null),
      createModel: vi.fn((_text: string, _language: string, uri: { value: string }) => {
        let disposed = false;
        const model = { uri, dispose: () => (disposed = true), isDisposed: () => disposed };
        models.push(model);
        return model;
      }),
    },
    languages: {
      FoldingRangeKind: { Comment: 'comment-kind', Region: 'region-kind', Imports: 'imports-kind' },
      registerImplementationProvider: register('implementation'),
      registerTypeDefinitionProvider: register('typeDefinition'),
      registerDeclarationProvider: register('declaration'),
      registerFoldingRangeProvider: register('folding'),
      registerSelectionRangeProvider: register('selection'),
      registerColorProvider: register('color'),
      registerLinkProvider: register('link'),
    },
  } as unknown as typeof Monaco;
  return { api, providers, actions, models };
}

const RANGE = { startLineNumber: 1, startColumn: 2, endLineNumber: 3, endColumn: 4 };

function setup(lspEditorFeature = vi.fn()) {
  const fake = fakeApi();
  const electron = {
    isElectron: true,
    lspEditorFeature,
    readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: 'text' }),
    readAbsoluteFile: vi.fn().mockResolvedValue({ ok: true, content: 'page' }),
    lspWorkspaceSymbols: vi.fn(),
  } as unknown as ElectronService;
  const onNavigate = vi.fn();
  const features = registerExtendedLspFeatures({
    monacoApi: fake.api,
    electron,
    getLspSessionId: () => 'session',
    getWorkspaceRoot: () => 'C:/ws',
    getWorkspaceRelativePathForModel: () => 'scripts/a.gd',
    isStoreModel: () => false,
    languageIdForPath: () => 'gdscript',
    getEditor: () => null,
    onNavigate,
  });
  return { ...fake, electron, onNavigate, features, lspEditorFeature };
}

const model = () =>
  ({
    getAlternativeVersionId: () => 1,
    getValue: () => 'buffer',
    uri: { value: 'clara-workspace:///scripts/a.gd' },
  }) as unknown as Monaco.editor.ITextModel;

describe('registerExtendedLspFeatures', () => {
  it('registers providers for GDScript only', () => {
    const { providers } = setup();
    expect([...providers.keys()].sort()).toEqual(
      ['color', 'declaration', 'folding', 'implementation', 'link', 'selection', 'typeDefinition'].sort(),
    );
    for (const entries of providers.values()) {
      expect(entries.map((e) => e.language)).toEqual(['gdscript']);
    }
  });

  it('scopes every editor action to GDScript', () => {
    const { actions } = setup();
    expect(actions.map((a) => a.id)).toEqual([
      'clara.gdscript.incomingCalls',
      'clara.gdscript.outgoingCalls',
      'clara.gdscript.supertypes',
      'clara.gdscript.subtypes',
      'clara.gdscript.workspaceSymbols',
    ]);
    for (const action of actions) {
      expect(action.precondition).toBe('editorLangId == gdscript');
    }
  });

  it('re-sends the buffer when the server no longer holds the editor text', async () => {
    const lspEditorFeature = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, syncedFromDisk: true, result: { ranges: [] } })
      .mockResolvedValueOnce({ ok: true, syncedFromDisk: false, result: { ranges: [] } });
    const { features } = setup(lspEditorFeature);
    await features.call(model(), 'foldingRanges');
    const texts = lspEditorFeature.mock.calls.map((call) => call[4]);
    expect(texts.at(-1)).toBe('buffer');
    expect(lspEditorFeature.mock.calls.at(-1)?.[5]).toBe(false);
  });

  it('maps folding kinds', async () => {
    const lspEditorFeature = vi.fn().mockResolvedValue({
      ok: true,
      syncedFromDisk: false,
      result: {
        ranges: [
          { start: 1, end: 2, kind: 'region' },
          { start: 3, end: 4, kind: 'comment' },
          { start: 5, end: 6, kind: null },
        ],
      },
    });
    const { providers } = setup(lspEditorFeature);
    const provide = providers.get('folding')![0]!.provider['provideFoldingRanges'] as unknown as (
      m: Monaco.editor.ITextModel,
    ) => Promise<Array<{ kind?: string }>>;
    const ranges = await provide(model());
    expect(ranges.map((r) => r.kind)).toEqual(['region-kind', 'comment-kind', undefined]);
  });

  it('turns a workspace link into a workspace URI and keeps web links', async () => {
    const lspEditorFeature = vi.fn().mockResolvedValue({
      ok: true,
      syncedFromDisk: false,
      result: {
        links: [
          { range: RANGE, relativePath: 'scripts/bone.gd' },
          { range: RANGE, url: 'https://godotengine.org' },
        ],
      },
    });
    const { providers } = setup(lspEditorFeature);
    const provide = providers.get('link')![0]!.provider['provideLinks'] as unknown as (
      m: Monaco.editor.ITextModel,
    ) => Promise<{ links: Array<{ url: unknown }> }>;
    const { links } = await provide(model());
    expect((links[0]!.url as { value: string }).value).toBe('clara-workspace:///scripts/bone.gd');
    expect(links[1]!.url).toBe('https://godotengine.org');
  });

  it('builds peek previews and replaces them on the next peek', async () => {
    const { features, api, models, electron } = setup();
    await features.ensurePeekModels([
      { relativePath: 'scripts/b.gd', range: RANGE },
      { relativePath: 'scripts/b.gd', range: RANGE },
      { relativePath: 'C:/rt/Node2D.gd', externalPath: 'C:/rt/Node2D.gd', range: RANGE },
    ]);
    expect(api.editor.createModel).toHaveBeenCalledTimes(2);
    expect(electron.readWorkspaceFile).toHaveBeenCalledExactlyOnceWith('C:/ws', 'scripts/b.gd');
    expect(electron.readAbsoluteFile).toHaveBeenCalledExactlyOnceWith('C:/rt/Node2D.gd');
    await features.ensurePeekModels([]);
    expect(models.every((m) => m.isDisposed())).toBe(true);
  });
});

describe('lspErrorMessage', () => {
  it('unwraps the route and client layers', () => {
    const raw = JSON.stringify({ detail: "LSP request failed for 'textDocument/prepareRename': Cannot rename `Node2D`" });
    expect(lspErrorMessage(raw)).toBe('Cannot rename `Node2D`');
  });

  it('leaves other text alone', () => {
    expect(lspErrorMessage('API not available')).toBe('API not available');
  });
});

describe('lspLocationUri', () => {
  const api = fakeApi().api;

  it('uses the workspace scheme for project files', () => {
    expect((lspLocationUri(api, { relativePath: 'a b/c.gd', range: RANGE }) as unknown as { value: string }).value).toBe(
      'clara-workspace:///a%20b/c.gd',
    );
  });

  it('uses the external scheme for generated pages', () => {
    const uri = lspLocationUri(api, {
      relativePath: 'C:/rt/Node2D.gd',
      externalPath: 'C:\\rt\\Node2D.gd',
      range: RANGE,
    }) as unknown as { value: string };
    expect(uri.value).toBe('clara-external:///C:/rt/Node2D.gd');
  });
});
