import { TestBed } from '@angular/core/testing';
import type * as Monaco from 'monaco-editor';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronService } from '../../../core/electron.service';
import { openEditorFileRefFromRelativePath } from '../open-editor-file-ref';
import { WorkspaceMonacoModelStore } from './workspace-monaco-model-store';

/** Minimal in-memory stand-in for `monaco.editor.ITextModel`. */
class FakeModel {
  private value: string;
  private altVersion = 1;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    value: string,
    readonly uri: { toString(): string },
  ) {
    this.value = value;
  }

  getValue(): string {
    return this.value;
  }

  setValue(v: string): void {
    this.value = v;
    this.altVersion += 1;
    for (const l of this.listeners) {
      l();
    }
  }

  /** Simulates a user edit. */
  type(text: string): void {
    this.setValue(this.value + text);
  }

  getAlternativeVersionId(): number {
    return this.altVersion;
  }

  onDidChangeContent(cb: () => void): Monaco.IDisposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function fakeMonaco(): { api: typeof Monaco; models: Map<string, FakeModel> } {
  const models = new Map<string, FakeModel>();
  const api = {
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    Range: class {},
    languages: { getLanguages: () => [] },
    editor: {
      getModel: (uri: { toString(): string }) => {
        const m = models.get(uri.toString());
        return m && !m.isDisposed() ? m : null;
      },
      createModel: (value: string, _lang: string, uri: { toString(): string }) => {
        const m = new FakeModel(value, uri);
        models.set(uri.toString(), m);
        return m;
      },
    },
  } as unknown as typeof Monaco;
  return { api, models };
}

describe('WorkspaceMonacoModelStore', () => {
  let store: WorkspaceMonacoModelStore;
  let models: Map<string, FakeModel>;
  let files: Record<string, string>;
  let lspEditorDidClose: ReturnType<typeof vi.fn>;
  let readAbsoluteFile: ReturnType<typeof vi.fn>;
  let writeWorkspaceFile: ReturnType<typeof vi.fn>;
  let lspWillRenameFiles: ReturnType<typeof vi.fn>;
  let lspDidRenameFiles: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    files = { 'src/a.ts': 'const a = 1;', 'src/b.ts': 'const b = 2;' };
    lspEditorDidClose = vi.fn(async () => ({ ok: true }));
    readAbsoluteFile = vi.fn(async () => ({ ok: false, error: 'unused' }));
    writeWorkspaceFile = vi.fn(async () => ({ ok: true }));
    lspWillRenameFiles = vi.fn();
    lspDidRenameFiles = vi.fn(async () => ({ ok: true }));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ElectronService,
          useValue: {
            workspaceFilesChanged$: new Subject(),
            readWorkspaceFile: vi.fn(async (_root: string, rel: string) =>
              rel in files ? { ok: true, content: files[rel] } : { ok: false, error: 'ENOENT' },
            ),
            readAbsoluteFile,
            writeWorkspaceFile,
            lspWillRenameFiles,
            lspDidRenameFiles,
            workspaceFileExists: vi.fn(async (_root: string, rel: string) => ({
              ok: true,
              exists: rel in files,
              isFile: rel in files,
            })),
            writeEditorDetachedSnapshot: vi.fn(async () => ({ ok: true, path: 'C:/tmp/snap.txt' })),
            deleteEditorDetachedSnapshot: vi.fn(async () => ({ ok: true })),
            lspEditorDidClose,
            lspEditorDidSave: vi.fn(async () => ({ ok: true })),
          },
        },
      ],
    });
    store = TestBed.inject(WorkspaceMonacoModelStore);
    const fake = fakeMonaco();
    models = fake.models;
    store.setMonaco(fake.api);
    store.setWorkspaceRoot('C:/ws');
  });

  describe('file rename edits', () => {
    const edit = (newText: string) => ({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
      newText,
    });

    it('asks the server with no editor ever opened', async () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: ElectronService,
            useValue: {
              workspaceFilesChanged$: new Subject(),
              lspWillRenameFiles: vi.fn(async () => ({ ok: true, changes: { 'b.gd': [edit('x')] } })),
            },
          },
        ],
      });
      const fresh = TestBed.inject(WorkspaceMonacoModelStore);
      expect(await fresh.fetchFileRenameEdits('conv-1', 'a.gd', 'c.gd')).toEqual({ 'b.gd': [edit('x')] });
    });

    it('applies with no editor ever opened, writing every file to disk', async () => {
      TestBed.resetTestingModule();
      const write = vi.fn(async () => ({ ok: true }));
      TestBed.configureTestingModule({
        providers: [
          {
            provide: ElectronService,
            useValue: {
              workspaceFilesChanged$: new Subject(),
              readWorkspaceFile: vi.fn(async () => ({ ok: true, content: 'hello world' })),
              writeWorkspaceFile: write,
            },
          },
        ],
      });
      const fresh = TestBed.inject(WorkspaceMonacoModelStore);
      await fresh.applyFileRenameEdits('C:/ws', 'a.gd', 'c.gd', { 'b.gd': [edit('bye')] });
      expect(write).toHaveBeenCalledExactlyOnceWith('C:/ws', 'b.gd', 'bye world');
    });

    it('asks nothing for a path the server has no interest in', async () => {
      expect(await store.fetchFileRenameEdits('conv-1', 'src/a.ts', 'src/z.ts')).toBeNull();
      expect(await store.fetchFileRenameEdits(null, 'a.gd', 'c.gd')).toBeNull();
      expect(lspWillRenameFiles).not.toHaveBeenCalled();
    });

    it('gives up when the server is unavailable', async () => {
      lspWillRenameFiles.mockResolvedValue({ ok: false, error: 'not installed' });
      expect(await store.fetchFileRenameEdits('conv-1', 'a.gd', 'c.gd')).toBeNull();
    });

    it('edits an open model and writes a moved closed file at its new path', async () => {
      files['src/open.gd'] = 'hello world';
      files['src/new.gd'] = 'hello moved';
      const ref = openEditorFileRefFromRelativePath('src/open.gd');
      store.syncOwner('slot-1', [ref]);
      const { model } = await store.getOrCreateModel(ref.modelKey);
      const pushed: unknown[] = [];
      (model as unknown as { pushEditOperations: (...args: unknown[]) => void }).pushEditOperations = (...args) =>
        pushed.push(args);

      await store.applyFileRenameEdits('C:/ws', 'src/old.gd', 'src/new.gd', {
        'src/open.gd': [edit('bye')],
        'src/old.gd': [edit('bye')],
      });
      expect(pushed).toHaveLength(1);
      expect(writeWorkspaceFile).toHaveBeenCalledExactlyOnceWith('C:/ws', 'src/new.gd', 'bye moved');
    });

    it('takes a preview model left by a peek for what it is: not an open file', async () => {
      files['src/peeked.gd'] = 'hello world';
      const fake = fakeMonaco();
      store.setMonaco(fake.api);
      // A peek made this model; no tab owns it, so an edit here would vanish with the next peek.
      fake.api.editor.createModel('stale', 'gdscript', fake.api.Uri.parse('clara-workspace:///src/peeked.gd'));

      await store.applyFileRenameEdits('C:/ws', 'a.gd', 'c.gd', { 'src/peeked.gd': [edit('bye')] });
      expect(writeWorkspaceFile).toHaveBeenCalledExactlyOnceWith('C:/ws', 'src/peeked.gd', 'bye world');
    });

    it('tells the server after the move, using the session it was given', () => {
      store.notifyFileRenamed('conv-1', 'a.gd', 'c.gd');
      expect(lspDidRenameFiles).toHaveBeenCalledExactlyOnceWith('conv-1', [
        { oldRelativePath: 'a.gd', newRelativePath: 'c.gd' },
      ]);
    });
  });

  describe('read-only pages', () => {
    const PAGE = 'abs:C:/rt/gdls/stubs/v1/Node2D.gd';

    it('takes read-only from main, so a tab restored after a restart stays read-only', async () => {
      readAbsoluteFile.mockResolvedValue({ ok: true, content: 'class_name Node2D', readOnly: true });
      expect(store.isReadOnlyKey(PAGE)).toBe(false);
      await store.getOrCreateModel(PAGE);
      expect(store.isReadOnlyKey(PAGE)).toBe(true);
    });

    it('leaves other files outside the workspace editable', async () => {
      const other = 'abs:C:/elsewhere/notes.txt';
      readAbsoluteFile.mockResolvedValue({ ok: true, content: 'notes', readOnly: false });
      await store.getOrCreateModel(other);
      expect(store.isReadOnlyKey(other)).toBe(false);
    });
  });

  it('creates a model once per key and shares it between owners', async () => {
    const ref = openEditorFileRefFromRelativePath('src/a.ts');
    store.syncOwner('slot-1', [ref]);
    store.syncOwner('slot-2', [ref]);

    const first = await store.getOrCreateModel(ref.modelKey);
    const second = await store.getOrCreateModel(ref.modelKey);
    expect(first.model).toBeTruthy();
    expect(second.model).toBe(first.model);
    expect(models.size).toBe(1);
    expect(first.model!.getValue()).toBe('const a = 1;');
  });

  it('keeps the model alive until the last owner releases it', async () => {
    const ref = openEditorFileRefFromRelativePath('src/a.ts');
    store.syncOwner('slot-1', [ref]);
    store.syncOwner('slot-2', [ref]);
    const { model } = await store.getOrCreateModel(ref.modelKey);

    // slot-1 stops showing the file; slot-2 still owns it.
    const released = store.syncOwner('slot-1', []);
    expect(released).toEqual([ref.modelKey]);
    expect(model!.isDisposed()).toBe(false);
    expect(store.getModel(ref.modelKey)).toBe(model);

    store.releaseOwner('slot-2');
    expect(model!.isDisposed()).toBe(true);
    expect(store.getModel(ref.modelKey)).toBeUndefined();
  });

  it('keeps unsaved edits when a tab moves between slots under the grid-wide claim', async () => {
    const ref = openEditorFileRefFromRelativePath('src/a.ts');
    store.syncGridOpenFiles([ref]);
    store.syncOwner('slot-1', [ref]);
    const { model } = await store.getOrCreateModel(ref.modelKey);
    (model as unknown as FakeModel).type(' // edited');
    expect(store.unsavedKeys()).toEqual(new Set([ref.modelKey]));

    // Old slot releases before the new slot (still loading Monaco) claims the key.
    store.syncOwner('slot-1', []);
    expect(model!.isDisposed()).toBe(false);
    expect(store.unsavedKeys()).toEqual(new Set([ref.modelKey]));

    store.syncOwner('slot-2', [ref]);
    const again = await store.getOrCreateModel(ref.modelKey);
    expect(again.model).toBe(model);
    expect(again.model!.getValue()).toBe('const a = 1; // edited');
    expect(models.size).toBe(1);

    // Closing the tab everywhere (grid claim + last slot) finally disposes it.
    store.syncGridOpenFiles([]);
    expect(model!.isDisposed()).toBe(false);
    store.syncOwner('slot-2', []);
    expect(model!.isDisposed()).toBe(true);
  });

  it('notifies the LSP once when the last owner of a workspace file closes it', async () => {
    store.setConversationId('conv-1');
    const ref = openEditorFileRefFromRelativePath('src/a.ts');
    store.syncOwner('slot-1', [ref]);
    store.syncOwner('slot-2', [ref]);
    await store.getOrCreateModel(ref.modelKey);

    store.releaseOwner('slot-1');
    expect(lspEditorDidClose).not.toHaveBeenCalled();
    store.releaseOwner('slot-2');
    expect(lspEditorDidClose).toHaveBeenCalledTimes(1);
    expect(lspEditorDidClose).toHaveBeenCalledWith('conv-1', 'src/a.ts');
  });

  it('tracks unsaved keys from buffer edits and clears them when synced to disk', async () => {
    const a = openEditorFileRefFromRelativePath('src/a.ts');
    const b = openEditorFileRefFromRelativePath('src/b.ts');
    store.syncOwner('slot-1', [a, b]);
    const { model } = await store.getOrCreateModel(a.modelKey);
    await store.getOrCreateModel(b.modelKey);
    expect(store.unsavedKeys().size).toBe(0);

    (model as unknown as FakeModel).type(' // edit');
    expect(store.unsavedKeys()).toEqual(new Set([a.modelKey]));
    expect(store.isKeyDirty(a.modelKey)).toBe(true);
    expect(store.isKeyDirty(b.modelKey)).toBe(false);

    store.markSyncedToDisk(a.modelKey);
    expect(store.unsavedKeys().size).toBe(0);
  });

  it('treats externally streamed content as saved', async () => {
    const a = openEditorFileRefFromRelativePath('src/a.ts');
    store.syncOwner('slot-1', [a]);
    const { model } = await store.getOrCreateModel(a.modelKey);
    store.setModelContentSynced(a.modelKey, 'streamed');
    expect(model!.getValue()).toBe('streamed');
    expect(store.unsavedKeys().size).toBe(0);
  });

  it('retargets a model to a new key and carries dirty state and owners', async () => {
    const a = openEditorFileRefFromRelativePath('src/a.ts');
    store.syncOwner('slot-1', [a]);
    store.syncOwner('slot-2', [a]);
    const { model } = await store.getOrCreateModel(a.modelKey);
    (model as unknown as FakeModel).type('!');
    expect(store.unsavedKeys()).toEqual(new Set([a.modelKey]));

    const renamed = openEditorFileRefFromRelativePath('src/renamed.ts');
    store.retargetModelKey(a.modelKey, renamed.modelKey);

    expect(store.getModel(a.modelKey)).toBeUndefined();
    expect(store.getModel(renamed.modelKey)).toBe(model);
    expect(store.unsavedKeys()).toEqual(new Set([renamed.modelKey]));

    // Both owners followed the rename: releasing one keeps the model alive.
    store.syncOwner('slot-1', []);
    expect(model!.isDisposed()).toBe(false);
    store.syncOwner('slot-2', []);
    expect(model!.isDisposed()).toBe(true);
  });

  it('reports a load error for missing workspace files', async () => {
    const missing = openEditorFileRefFromRelativePath('src/missing.ts');
    store.syncOwner('slot-1', [missing]);
    const res = await store.getOrCreateModel(missing.modelKey);
    expect(res.model).toBeNull();
    expect(res.error).toBe('ENOENT');
  });
});
