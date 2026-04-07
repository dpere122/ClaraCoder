import { Component, effect, input, OnDestroy, output, signal, ViewEncapsulation } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import type { Workspace } from '@shared/index';
import { ElectronService } from '../../../core/electron.service';
import { Subscription } from 'rxjs';

type WorkspaceChangeKind = 'created' | 'updated' | 'deleted' | 'renamed' | 'unknown';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  expanded: boolean;
  children: FileNode[] | null;
  depth: number;
}

interface FlatNode {
  name: string;
  path: string;
  isDirectory: boolean;
  expanded: boolean;
  depth: number;
  hasChildren: boolean;
}

@Component({
  selector: 'app-workspace',
  imports: [FormsModule, LucideAngularModule],
  templateUrl: './workspace.html',
  styleUrl: './workspace.css',
  encapsulation: ViewEncapsulation.None,
})
export class WorkspaceComponent implements OnDestroy {
  readonly workspaces = input<Workspace[]>([]);
  readonly currentWorkspaceId = input<string | null>(null);

  readonly workspaceChanged = output<string | null>();
  readonly addWorkspace = output<void>();

  protected readonly flatTree = signal<FlatNode[]>([]);
  protected readonly loadError = signal('');
  protected readonly lastWorkspaceChange = signal<string>('');

  private tree: FileNode[] = [];
  private workspaceSubscription: Subscription | null = null;
  private workspaceFilesChangedSubscription: Subscription | null = null;
  private pendingWorkspaceId: string | undefined = undefined;
  private loadRequestId = 0;

  constructor(private electron: ElectronService) {
    effect(() => {
      const wsId = this.currentWorkspaceId();
      const workspaces = this.workspaces();
      void this.loadWorkspaceFromConfig(wsId, workspaces);
    });

    this.workspaceSubscription = this.electron.workspaceChanged$.subscribe((workspaceId) => {
      this.pendingWorkspaceId = workspaceId ?? undefined;
      void this.loadWorkspaceFromConfig();
    });

    this.workspaceFilesChangedSubscription = this.electron.workspaceFilesChanged$.subscribe((event) => {
      const currentWorkspace = this.workspaces().find((workspace) => workspace.id === this.currentWorkspaceId());
      if (!currentWorkspace || currentWorkspace.id !== event.workspaceId) {
        return;
      }

      this.lastWorkspaceChange.set(this.describeWorkspaceChange(event));
      void this.reloadPreservingExpansion(currentWorkspace.path);
    });
  }

  ngOnDestroy(): void {
    this.workspaceSubscription?.unsubscribe();
    this.workspaceFilesChangedSubscription?.unsubscribe();
  }

  get currentWorkspaceName(): string {
    const ws = this.workspaces().find(w => w.id === this.currentWorkspaceId());
    return ws?.name ?? 'No workspace';
  }

  onWorkspaceSelectChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    this.workspaceChanged.emit(value || null);
  }

  onAddWorkspace(): void {
    this.addWorkspace.emit();
  }

  private async loadWorkspaceFromConfig(wsId = this.currentWorkspaceId(), workspaces = this.workspaces()): Promise<void> {
    const targetWorkspaceId = (this.pendingWorkspaceId !== undefined)
      ? this.pendingWorkspaceId
      : wsId;
    this.pendingWorkspaceId = undefined;
    const ws = workspaces.find(w => w.id === targetWorkspaceId);
    await this.loadRoot(ws?.path);
  }

  async loadRoot(dirPath?: string): Promise<void> {
    const requestId = ++this.loadRequestId;
    const pathToLoad = dirPath || this.workspaces().find(w => w.id === this.currentWorkspaceId())?.path;
    if (!pathToLoad) {
      this.tree = [];
      this.loadError.set('');
      this.lastWorkspaceChange.set('');
      this.rebuildFlat();
      return;
    }

    try {
      const entries = await this.electron.readDirectory(pathToLoad);
      if (requestId !== this.loadRequestId) return;
      this.tree = entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDirectory: e.isDirectory,
        expanded: false,
        children: e.isDirectory ? null : [],
        depth: 0,
      }));
      this.loadError.set('');
      this.rebuildFlat();
    } catch {
      if (requestId !== this.loadRequestId) return;
      this.tree = [];
      this.loadError.set('Unable to read this workspace. It may be missing or inaccessible.');
      this.rebuildFlat();
    }
  }

  private async reloadPreservingExpansion(dirPath: string): Promise<void> {
    const expandedPaths = this.collectExpandedPaths(this.tree);
    await this.loadRoot(dirPath);
    if (expandedPaths.size === 0 || this.loadError()) {
      return;
    }

    await this.restoreExpandedPaths(expandedPaths);
  }

  async onTreeNodeClick(node: FlatNode): Promise<void> {
    if (!node.isDirectory) {
      return;
    }
    await this.toggleFolder(node);
  }

  async toggleFolder(node: FlatNode): Promise<void> {
    const treeNode = this.findNode(this.tree, node.path);
    if (!treeNode || !treeNode.isDirectory) return;

    if (treeNode.expanded) {
      treeNode.expanded = false;
    } else {
      if (treeNode.children === null) {
        try {
          const entries = await this.electron.readDirectory(treeNode.path);
          treeNode.children = entries.map((e) => ({
            name: e.name,
            path: e.path,
            isDirectory: e.isDirectory,
            expanded: false,
            children: e.isDirectory ? null : [],
            depth: treeNode.depth + 1,
          }));
        } catch {
          treeNode.children = [];
        }
      }
      treeNode.expanded = true;
    }
    this.rebuildFlat();
  }

  private findNode(nodes: FileNode[], targetPath: string): FileNode | null {
    for (const n of nodes) {
      if (n.path === targetPath) return n;
      if (n.children) {
        const found = this.findNode(n.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  }

  private rebuildFlat(): void {
    const result: FlatNode[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        result.push({
          name: n.name,
          path: n.path,
          isDirectory: n.isDirectory,
          expanded: n.expanded,
          depth: n.depth,
          hasChildren: n.isDirectory && (n.children === null || n.children.length > 0),
        });
        if (n.expanded && n.children) {
          walk(n.children);
        }
      }
    };
    walk(this.tree);
    this.flatTree.set(result);
  }

  private collectExpandedPaths(nodes: FileNode[]): Set<string> {
    const expandedPaths = new Set<string>();
    const walk = (items: FileNode[]) => {
      for (const item of items) {
        if (item.isDirectory && item.expanded) {
          expandedPaths.add(item.path);
        }
        if (item.children && item.children.length > 0) {
          walk(item.children);
        }
      }
    };
    walk(nodes);
    return expandedPaths;
  }

  private async restoreExpandedPaths(expandedPaths: Set<string>): Promise<void> {
    const sortedPaths = Array.from(expandedPaths).sort((a, b) => a.length - b.length);
    for (const targetPath of sortedPaths) {
      const node = this.findNode(this.tree, targetPath);
      if (!node || !node.isDirectory) {
        continue;
      }

      if (node.children === null) {
        try {
          const entries = await this.electron.readDirectory(node.path);
          node.children = entries.map((entry) => ({
            name: entry.name,
            path: entry.path,
            isDirectory: entry.isDirectory,
            expanded: false,
            children: entry.isDirectory ? null : [],
            depth: node.depth + 1,
          }));
        } catch {
          node.children = [];
        }
      }

      node.expanded = true;
    }

    this.rebuildFlat();
  }

  private describeWorkspaceChange(event: { paths: string[]; kinds: WorkspaceChangeKind[] }): string {
    const kind = event.kinds[0] ?? 'unknown';
    const pathLabel = event.paths[0] ?? 'workspace';
    const moreCount = Math.max(0, event.paths.length - 1);
    const kindLabel = kind === 'unknown' ? 'changed' : kind;
    if (moreCount === 0) {
      return `${pathLabel} ${kindLabel}`;
    }
    return `${pathLabel} ${kindLabel} (+${moreCount} more)`;
  }
}
