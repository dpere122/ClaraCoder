import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { WorkspaceFileChangeStatusService } from '../../../core/workspace-file-change-status.service';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import {
  WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME,
  WORKSPACE_TREE_INTERNAL_MOVE_MIME,
} from '../../chat/chat-context-bar/chat-context-file';
import type { FileNode, FlatNode } from './workspace-tree';
import { WorkspaceComponent } from './workspace';

const WS_PATH = '/tmp/ws';
const SRC_DIR = '/tmp/ws/src';
const FOO_FILE = '/tmp/ws/src/foo.ts';

function sampleWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'tmp',
    path: WS_PATH,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function sampleTree(): FileNode[] {
  return [
    {
      name: 'src',
      path: SRC_DIR,
      isDirectory: true,
      expanded: true,
      depth: 0,
      children: [
        {
          name: 'foo.ts',
          path: FOO_FILE,
          isDirectory: false,
          expanded: false,
          children: null,
          depth: 1,
        },
      ],
    },
  ];
}

type CreateSignals = {
  tree: FileNode[];
  selectedPath: { set: (v: string | null) => void };
  pendingCreate: () => { kind: 'file' | 'folder'; parentDir: string } | null;
};

function createSignals(component: WorkspaceComponent): CreateSignals {
  return component as unknown as CreateSignals;
}

describe('WorkspaceComponent.beginCreateFromMenu', () => {
  let fixture: ComponentFixture<WorkspaceComponent>;
  let component: WorkspaceComponent;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [WorkspaceComponent],
      providers: [
        { provide: ThemedConfirmDialogService, useValue: { open: vi.fn() } },
        { provide: WorkspaceFileChangeStatusService, useValue: { showFileName: vi.fn(), clear: vi.fn() } },
        {
          provide: ElectronService,
          useValue: {
            isElectron: false,
            workspaceChanged$: new Subject<string | null>().asObservable(),
            workspaceFilesChanged$: new Subject<never>().asObservable(),
            llamaServerLifecycle$: new Subject<never>().asObservable(),
            llamaServerProcessExit$: new Subject<never>().asObservable(),
            readDirectory: vi.fn().mockResolvedValue([]),
          },
        },
      ],
    })
      .overrideComponent(WorkspaceComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    fixture = TestBed.createComponent(WorkspaceComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
  });

  async function flushPendingCreate(): Promise<void> {
    await fixture.whenStable();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('is a no-op when there is no current workspace or the path is empty', async () => {
    fixture.componentRef.setInput('workspaces', []);
    fixture.componentRef.setInput('currentWorkspaceId', null);
    component.beginCreateFromMenu('file');
    await flushPendingCreate();
    expect(createSignals(component).pendingCreate()).toBeNull();

    fixture.componentRef.setInput('workspaces', [sampleWorkspace({ path: '   ' })]);
    fixture.componentRef.setInput('currentWorkspaceId', 'ws-1');
    component.beginCreateFromMenu('folder');
    await flushPendingCreate();
    expect(createSignals(component).pendingCreate()).toBeNull();
  });

  it('starts a pending create at the workspace root when no node is selected', async () => {
    fixture.componentRef.setInput('workspaces', [sampleWorkspace()]);
    fixture.componentRef.setInput('currentWorkspaceId', 'ws-1');
    const signals = createSignals(component);
    signals.tree = sampleTree();
    signals.selectedPath.set(null);

    component.beginCreateFromMenu('file');
    await flushPendingCreate();
    expect(signals.pendingCreate()).toEqual({ kind: 'file', parentDir: WS_PATH });

    component.beginCreateFromMenu('folder');
    await flushPendingCreate();
    expect(signals.pendingCreate()).toEqual({ kind: 'folder', parentDir: WS_PATH });
  });

  it('uses the parent directory when the selected node is a file', async () => {
    fixture.componentRef.setInput('workspaces', [sampleWorkspace()]);
    fixture.componentRef.setInput('currentWorkspaceId', 'ws-1');
    const signals = createSignals(component);
    signals.tree = sampleTree();
    signals.selectedPath.set(FOO_FILE);

    component.beginCreateFromMenu('file');
    await flushPendingCreate();
    expect(signals.pendingCreate()).toEqual({ kind: 'file', parentDir: SRC_DIR });
  });

  it('uses the directory path when the selected node is a directory', async () => {
    fixture.componentRef.setInput('workspaces', [sampleWorkspace()]);
    fixture.componentRef.setInput('currentWorkspaceId', 'ws-1');
    const signals = createSignals(component);
    signals.tree = sampleTree();
    signals.selectedPath.set(SRC_DIR);

    component.beginCreateFromMenu('folder');
    await flushPendingCreate();
    expect(signals.pendingCreate()).toEqual({ kind: 'folder', parentDir: SRC_DIR });
  });
});

describe('WorkspaceComponent.confirmMoveIfNeeded', () => {
  let fixture: ComponentFixture<WorkspaceComponent>;
  let component: WorkspaceComponent;
  const openWithCheckbox = vi.fn();

  type MoveGuard = {
    confirmMoveIfNeeded: (source: string, dest: string, isDirectory?: boolean | null) => Promise<boolean>;
  };
  type TreeAccess = { flatTree: { set: (nodes: FlatNode[]) => void } };

  function dirNode(path: string): FlatNode {
    return { name: 'src', path, isDirectory: true, expanded: true, depth: 0, hasChildren: true };
  }

  function fileNode(path: string): FlatNode {
    return { name: 'foo.ts', path, isDirectory: false, expanded: false, depth: 0, hasChildren: false };
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [WorkspaceComponent],
      providers: [
        { provide: ThemedConfirmDialogService, useValue: { open: vi.fn(), openWithCheckbox } },
        { provide: WorkspaceFileChangeStatusService, useValue: { showFileName: vi.fn(), clear: vi.fn() } },
        {
          provide: ElectronService,
          useValue: {
            isElectron: false,
            workspaceChanged$: new Subject<string | null>().asObservable(),
            workspaceFilesChanged$: new Subject<never>().asObservable(),
            llamaServerLifecycle$: new Subject<never>().asObservable(),
            llamaServerProcessExit$: new Subject<never>().asObservable(),
            readDirectory: vi.fn().mockResolvedValue([]),
          },
        },
      ],
    })
      .overrideComponent(WorkspaceComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    fixture = TestBed.createComponent(WorkspaceComponent);
    component = fixture.componentInstance;
    openWithCheckbox.mockReset();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('prompts for files and returns false when cancelled', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: true } as never);
    (component as unknown as TreeAccess).flatTree.set([fileNode(FOO_FILE)]);
    openWithCheckbox.mockResolvedValue({ result: 'cancel', checked: false });

    const ok = await (component as unknown as MoveGuard).confirmMoveIfNeeded(FOO_FILE, SRC_DIR);

    expect(ok).toBe(false);
    expect(openWithCheckbox).toHaveBeenCalledOnce();
    expect(openWithCheckbox.mock.calls[0][0]).toMatchObject({ title: 'Move file?' });
  });

  it('prompts for folders and returns false when cancelled', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: true } as never);
    (component as unknown as TreeAccess).flatTree.set([dirNode(SRC_DIR)]);
    openWithCheckbox.mockResolvedValue({ result: 'cancel', checked: false });

    const ok = await (component as unknown as MoveGuard).confirmMoveIfNeeded(SRC_DIR, '/tmp/ws/dest');

    expect(ok).toBe(false);
    expect(openWithCheckbox).toHaveBeenCalledOnce();
    expect(openWithCheckbox.mock.calls[0][0]).toMatchObject({ title: 'Move folder?' });
  });

  it('trusts the drag payload over the tree when the source row is gone', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: true } as never);
    (component as unknown as TreeAccess).flatTree.set([]);
    openWithCheckbox.mockResolvedValue({ result: 'cancel', checked: false });

    await (component as unknown as MoveGuard).confirmMoveIfNeeded(SRC_DIR, '/tmp/ws/dest', true);

    expect(openWithCheckbox.mock.calls[0][0]).toMatchObject({ title: 'Move folder?' });
  });

  it('falls back to the tree when the drag payload has no directory flag', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: true } as never);
    (component as unknown as TreeAccess).flatTree.set([dirNode(SRC_DIR)]);
    openWithCheckbox.mockResolvedValue({ result: 'cancel', checked: false });

    await (component as unknown as MoveGuard).confirmMoveIfNeeded(SRC_DIR, '/tmp/ws/dest', null);

    expect(openWithCheckbox.mock.calls[0][0]).toMatchObject({ title: 'Move folder?' });
  });

  it('emits moveConfirmDisabled when the box is ticked', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: true } as never);
    (component as unknown as TreeAccess).flatTree.set([dirNode(SRC_DIR)]);
    openWithCheckbox.mockResolvedValue({ result: 'confirm', checked: true });
    const emitted = vi.fn();
    component.moveConfirmDisabled.subscribe(emitted);

    const ok = await (component as unknown as MoveGuard).confirmMoveIfNeeded(SRC_DIR, '/tmp/ws/dest');

    expect(ok).toBe(true);
    expect(emitted).toHaveBeenCalledOnce();
  });

  it('skips the prompt when the preference is disabled', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: false } as never);
    (component as unknown as TreeAccess).flatTree.set([dirNode(SRC_DIR)]);

    const ok = await (component as unknown as MoveGuard).confirmMoveIfNeeded(SRC_DIR, '/tmp/ws/dest');

    expect(ok).toBe(true);
    expect(openWithCheckbox).not.toHaveBeenCalled();
  });
});

describe('WorkspaceComponent.performTreeDrop', () => {
  const DEST_DIR = '/tmp/ws/dest';
  let fixture: ComponentFixture<WorkspaceComponent>;
  let component: WorkspaceComponent;
  const openWithCheckbox = vi.fn();
  const moveWorkspaceEntry = vi.fn();

  type DropAccess = { performTreeDrop: (event: DragEvent, root: string, dest: string) => Promise<void> };

  function dropEvent(source: string, isDirectory: boolean): DragEvent {
    const data = new Map<string, string>([
      [WORKSPACE_TREE_INTERNAL_MOVE_MIME, source],
      [WORKSPACE_TREE_DRAG_IS_DIRECTORY_MIME, isDirectory ? '1' : '0'],
    ]);
    return {
      dataTransfer: {
        types: [WORKSPACE_TREE_INTERNAL_MOVE_MIME],
        files: [],
        getData: (type: string) => data.get(type) ?? '',
      },
    } as unknown as DragEvent;
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [WorkspaceComponent],
      providers: [
        { provide: ThemedConfirmDialogService, useValue: { open: vi.fn(), openWithCheckbox } },
        { provide: WorkspaceFileChangeStatusService, useValue: { showFileName: vi.fn(), clear: vi.fn() } },
        {
          provide: ElectronService,
          useValue: {
            isElectron: false,
            workspaceChanged$: new Subject<string | null>().asObservable(),
            workspaceFilesChanged$: new Subject<never>().asObservable(),
            llamaServerLifecycle$: new Subject<never>().asObservable(),
            llamaServerProcessExit$: new Subject<never>().asObservable(),
            readDirectory: vi.fn().mockResolvedValue([]),
            moveWorkspaceEntry,
          },
        },
      ],
    })
      .overrideComponent(WorkspaceComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    fixture = TestBed.createComponent(WorkspaceComponent);
    component = fixture.componentInstance;
    openWithCheckbox.mockReset();
    moveWorkspaceEntry.mockReset();
    moveWorkspaceEntry.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('does not move when the prompt is cancelled', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: true } as never);
    openWithCheckbox.mockResolvedValue({ result: 'cancel', checked: false });

    await (component as unknown as DropAccess).performTreeDrop(dropEvent(FOO_FILE, false), WS_PATH, DEST_DIR);

    expect(moveWorkspaceEntry).not.toHaveBeenCalled();
  });

  it('moves once and ignores a second drop of the same source while the first is in flight', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: false } as never);
    const drop = component as unknown as DropAccess;

    await Promise.all([
      drop.performTreeDrop(dropEvent(FOO_FILE, false), WS_PATH, DEST_DIR),
      drop.performTreeDrop(dropEvent(FOO_FILE, false), WS_PATH, DEST_DIR),
    ]);

    expect(moveWorkspaceEntry).toHaveBeenCalledOnce();
    expect(moveWorkspaceEntry).toHaveBeenCalledWith(WS_PATH, FOO_FILE, DEST_DIR);
  });

  it('allows a later move of the same source once the first settles', async () => {
    fixture.componentRef.setInput('appConfig', { confirmMove: false } as never);
    const drop = component as unknown as DropAccess;

    await drop.performTreeDrop(dropEvent(FOO_FILE, false), WS_PATH, DEST_DIR);
    await drop.performTreeDrop(dropEvent(FOO_FILE, false), WS_PATH, DEST_DIR);

    expect(moveWorkspaceEntry).toHaveBeenCalledTimes(2);
  });
});
