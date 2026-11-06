import type * as Monaco from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import type { ElectronService } from '../../../core/electron.service';
import { registerWorkspaceMonacoLsp } from './workspace-monaco-lsp';

type Opener = {
  openCodeEditor: (source: unknown, resource: unknown, selectionOrPosition?: unknown) => boolean;
};
type RenameProvider = {
  provideRenameEdits: (
    model: unknown,
    position: unknown,
    newName: string,
    token: unknown,
  ) => Promise<{ edits: Array<{ resource: { value: string } }>; rejectReason?: string } | null>;
};

function uri(value: string) {
  const [scheme, rest] = value.split(':///');
  return { value, scheme, path: `/${rest}`, toString: () => value };
}

function setup() {
  const openers: Opener[] = [];
  const renameProviders = new Map<string, RenameProvider>();
  const models = new Map<string, { uri: { value: string }; getAlternativeVersionId: () => number; getValue: () => string }>();
  const storeModels = new Set<unknown>();
  const register = vi.fn(() => ({ dispose: vi.fn() }));
  const api = {
    Uri: { parse: uri },
    Range: class {},
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyT: 50 },
    editor: {
      addEditorAction: register,
      registerCommand: register,
      registerEditorOpener: (opener: Opener) => {
        openers.push(opener);
        return { dispose: vi.fn() };
      },
      getModel: (u: { value: string }) => models.get(u.value) ?? null,
      createModel: vi.fn(),
    },
    languages: new Proxy(
      {
        FoldingRangeKind: {},
        registerRenameProvider: (language: string, provider: RenameProvider) => {
          renameProviders.set(language, provider);
          return { dispose: vi.fn() };
        },
      } as Record<string, unknown>,
      { get: (target, name: string) => target[name] ?? register },
    ),
  } as unknown as typeof Monaco;
  const electron = {
    isElectron: true,
    lspEditorRename: vi.fn(),
    readWorkspaceFile: vi.fn().mockResolvedValue({ ok: true, content: 'old text' }),
    writeWorkspaceFile: vi.fn().mockResolvedValue({ ok: true }),
  };
  const onNavigate = vi.fn();
  registerWorkspaceMonacoLsp({
    monacoApi: api,
    electron: electron as unknown as ElectronService,
    getLspSessionId: () => 'session',
    getConversationId: () => 'session',
    getWorkspaceRelativePathForModel: (model) =>
      (model as unknown as { uri: { value: string } }).uri.value.split(':///')[1],
    getDiagnosticsForModel: () => [],
    getEditorTabSettings: () => ({ tabSize: 4, insertSpaces: true, formatOnSave: false }),
    onNavigateToWorkspaceFile: onNavigate,
    getEditor: () => null,
    getWorkspaceRoot: () => 'C:/ws',
    isStoreModel: (model) => storeModels.has(model),
    languageIdForPath: () => 'gdscript',
  });
  const addModel = (value: string, inStore: boolean) => {
    const model = { uri: uri(value), getAlternativeVersionId: () => 1, getValue: () => 'text' };
    models.set(value, model);
    if (inStore) {
      storeModels.add(model);
    }
    return model;
  };
  return { opener: openers[0]!, renameProviders, electron, onNavigate, addModel };
}

describe('the workspace editor opener', () => {
  const HERE = 'clara-workspace:///scripts/a.gd';
  const source = { getModel: () => ({ uri: uri(HERE) }) };

  it("ignores the peek command opening the file it starts from: the caret must stay put", () => {
    const { opener, onNavigate } = setup();
    expect(opener.openCodeEditor(source, uri(HERE))).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('navigates within the same file when given a position', () => {
    const { opener, onNavigate } = setup();
    opener.openCodeEditor(source, uri(HERE), { lineNumber: 7, column: 2 });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ relativePath: 'scripts/a.gd', line: 7, column: 2 });
  });

  it('opens another file at its top when given no position', () => {
    const { opener, onNavigate } = setup();
    opener.openCodeEditor(source, uri('clara-workspace:///scripts/b.gd'));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ relativePath: 'scripts/b.gd', line: 1, column: 1 });
  });

  it('opens an engine page by its absolute path', () => {
    const { opener, onNavigate } = setup();
    opener.openCodeEditor(source, uri('clara-external:///C:/rt/Node2D.gd'), { lineNumber: 5, column: 12 });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({
      relativePath: 'C:/rt/Node2D.gd',
      absolutePath: 'C:/rt/Node2D.gd',
      line: 5,
      column: 12,
    });
  });

  it('leaves other schemes to Monaco', () => {
    const { opener, onNavigate } = setup();
    expect(opener.openCodeEditor(source, uri('https:///example.org'))).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('a multi-file rename', () => {
  const RANGE = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };
  const NOT_CANCELLED = { isCancellationRequested: false };

  it('writes a file known only to a peek preview to disk, and edits a tab through Monaco', async () => {
    const { renameProviders, electron, addModel } = setup();
    const here = addModel('clara-workspace:///scripts/a.gd', true);
    addModel('clara-workspace:///scripts/peeked.gd', false);
    electron.lspEditorRename.mockResolvedValue({
      ok: true,
      workspaceEdit: {
        changes: {
          'scripts/a.gd': [{ range: RANGE, newText: 'new' }],
          'scripts/peeked.gd': [{ range: RANGE, newText: 'new' }],
        },
      },
    });

    const result = await renameProviders.get('gdscript')!.provideRenameEdits(here, {}, 'new', NOT_CANCELLED);

    expect(electron.writeWorkspaceFile).toHaveBeenCalledExactlyOnceWith('C:/ws', 'scripts/peeked.gd', 'new text');
    expect(result!.edits.map((edit) => edit.resource.value)).toEqual(['clara-workspace:///scripts/a.gd']);
  });

  it('rejects with the reason when a closed file cannot be read, changing nothing', async () => {
    const { renameProviders, electron, addModel } = setup();
    const here = addModel('clara-workspace:///scripts/a.gd', true);
    electron.readWorkspaceFile.mockResolvedValue({ ok: false, error: 'too large' });
    electron.lspEditorRename.mockResolvedValue({
      ok: true,
      workspaceEdit: { changes: { 'scripts/b.gd': [{ range: RANGE, newText: 'new' }] } },
    });

    const result = await renameProviders.get('gdscript')!.provideRenameEdits(here, {}, 'new', NOT_CANCELLED);

    expect(result).toMatchObject({ edits: [], rejectReason: expect.stringContaining('too large') });
    expect(electron.writeWorkspaceFile).not.toHaveBeenCalled();
  });
});
