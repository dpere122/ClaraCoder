import { Component, ViewEncapsulation, computed, inject, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import type { TurnEditedFile, TurnEditedFileRow } from '@shared/index';
import { ElectronService } from '../../../../core/electron.service';
import { ConversationSessionService } from '../../../shell/conversation-session.service';

/** Open the read-only before/after diff of one file a turn edited. */
export interface TurnDiffOpenRequest {
  userMessageId: string;
  relativePath: string;
  turnNumber: number;
}

export type TurnEditedFileDisplayStatus = 'kept' | 'reset' | 'changed';

export interface TurnEditedFileDisplayRow extends TurnEditedFile {
  displayStatus: TurnEditedFileDisplayStatus;
}

/** Inline overwrite prompt after a reset hit files that changed since the turn. */
interface TurnResetConflict {
  /** Paths the user asked to reset; null = Reset all. */
  paths: string[] | null;
  conflicts: string[];
}

/** Note queued for the agent's next request after a path is reset. */
export function turnResetWorkspaceNote(relativePath: string, turnNumber: number): string {
  return `User reset \`${relativePath}\` from turn ${turnNumber} to its pre-edit state`;
}

export function turnEditedFileDisplayStatus(
  file: TurnEditedFile,
  live: TurnEditedFileRow | undefined,
): TurnEditedFileDisplayStatus {
  if (file.status === 'reset') {
    return 'reset';
  }
  return live?.changedSinceTurn ? 'changed' : 'kept';
}

/** File name and parent folder for a compact row label. */
export function splitTurnFilePath(relativePath: string): { name: string; dir: string } {
  const norm = relativePath.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? { name: norm.slice(i + 1), dir: norm.slice(0, i) } : { name: norm, dir: '' };
}

/**
 * End-of-turn edit review under an assistant reply: which files the turn wrote (+/− lines), a
 * per-file and Reset-all revert to the pre-turn state, and a diff tab per file.
 */
@Component({
  selector: 'app-turn-edits-footer',
  standalone: true,
  imports: [LucideAngularModule],
  templateUrl: './turn-edits-footer.html',
  styleUrl: './turn-edits-footer.css',
  encapsulation: ViewEncapsulation.None,
})
export class TurnEditsFooterComponent {
  private readonly electron = inject(ElectronService);
  private readonly session = inject(ConversationSessionService);

  readonly conversationId = input<string | null>(null);
  /** User message that started the turn (journal / turn-files key). */
  readonly userMessageId = input<string | null>(null);
  /** 1-based turn number for labels and reset notes. */
  readonly turnNumber = input(1);
  readonly files = input.required<readonly TurnEditedFile[]>();

  readonly openDiff = output<TurnDiffOpenRequest>();

  readonly expanded = signal(false);
  /** Live disk check from main (`list-turn-files`); null until first loaded. */
  private readonly liveRows = signal<readonly TurnEditedFileRow[] | null>(null);
  readonly busy = signal(false);
  readonly conflict = signal<TurnResetConflict | null>(null);
  readonly error = signal('');

  readonly totals = computed(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of this.files()) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { additions, deletions };
  });

  readonly rows = computed((): TurnEditedFileDisplayRow[] => {
    const live = new Map((this.liveRows() ?? []).map((r) => [r.relativePath, r]));
    return this.files().map((f) => ({ ...f, displayStatus: turnEditedFileDisplayStatus(f, live.get(f.relativePath)) }));
  });

  readonly canResetAll = computed(() => this.files().some((f) => f.status === 'kept'));

  readonly headerLabel = computed(() => {
    const n = this.files().length;
    return `${n} ${n === 1 ? 'file' : 'files'} edited`;
  });

  toggleExpanded(): void {
    const next = !this.expanded();
    this.expanded.set(next);
    if (next) {
      void this.refreshLiveRows();
    }
  }

  onOpenRow(row: TurnEditedFileDisplayRow): void {
    const userMessageId = this.userMessageId();
    if (!userMessageId) {
      return;
    }
    this.openDiff.emit({ userMessageId, relativePath: row.relativePath, turnNumber: this.turnNumber() });
  }

  async onResetFile(row: TurnEditedFileDisplayRow, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.reset([row.relativePath], false);
  }

  async onResetAll(event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.reset(null, false);
  }

  async onConfirmOverwrite(): Promise<void> {
    const c = this.conflict();
    if (!c) {
      return;
    }
    await this.reset(c.paths, true);
  }

  onCancelOverwrite(): void {
    this.conflict.set(null);
  }

  isConflicted(relativePath: string): boolean {
    return this.conflict()?.conflicts.includes(relativePath) ?? false;
  }

  opIcon(row: TurnEditedFile): string {
    switch (row.op) {
      case 'create':
        return 'file-plus';
      case 'delete':
        return 'file-minus';
      case 'delete-tree':
        return 'folder-minus';
      case 'copy':
        return 'file-symlink';
      default:
        return 'file-pen';
    }
  }

  opLabel(row: TurnEditedFile): string {
    switch (row.op) {
      case 'create':
        return 'Created';
      case 'delete':
        return 'Deleted';
      case 'delete-tree':
        return 'Deleted folder';
      case 'copy':
        return 'Copied';
      default:
        return 'Modified';
    }
  }

  statusLabel(row: TurnEditedFileDisplayRow): string {
    switch (row.displayStatus) {
      case 'reset':
        return 'reset';
      case 'changed':
        return 'changed since';
      default:
        return 'kept';
    }
  }

  pathParts(relativePath: string): { name: string; dir: string } {
    return splitTurnFilePath(relativePath);
  }

  private async refreshLiveRows(): Promise<void> {
    const conversationId = this.conversationId();
    const userMessageId = this.userMessageId();
    if (!conversationId || !userMessageId) {
      return;
    }
    try {
      this.liveRows.set(await this.electron.listTurnFiles(conversationId, userMessageId));
    } catch {
      // Keep persisted statuses when the disk check fails.
    }
  }

  private async reset(paths: string[] | null, force: boolean): Promise<void> {
    const conversationId = this.conversationId();
    const userMessageId = this.userMessageId();
    if (!conversationId || !userMessageId || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.electron.resetTurnFiles({
        conversationId,
        userMessageId,
        ...(paths ? { paths } : {}),
        force,
      });
      if (!res.ok) {
        if (res.conflicts?.length) {
          this.expanded.set(true);
          this.conflict.set({ paths, conflicts: res.conflicts });
        } else {
          this.error.set(res.error || 'Reset failed.');
        }
        return;
      }
      this.conflict.set(null);
      this.session.applyTurnEditedFiles(userMessageId, res.files);
      for (const p of res.resetPaths) {
        this.session.queueWorkspaceNote(conversationId, turnResetWorkspaceNote(p, this.turnNumber()));
      }
      if (res.skippedPaths.length > 0) {
        this.error.set(`Could not reset: ${res.skippedPaths.join(', ')}`);
      }
      await this.refreshLiveRows();
    } finally {
      this.busy.set(false);
    }
  }
}
