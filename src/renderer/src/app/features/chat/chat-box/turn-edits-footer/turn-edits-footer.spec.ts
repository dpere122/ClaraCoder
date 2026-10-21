import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetTurnFilesResult, TurnEditedFile, TurnEditedFileRow } from '@shared/index';
import { lucideAppProviders } from '../../../../lucide-setup';
import { ElectronService } from '../../../../core/electron.service';
import { ConversationSessionService } from '../../../shell/conversation-session.service';
import { ThemedConfirmDialogService } from '../../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import {
  TurnEditsFooterComponent,
  splitTurnFilePath,
  turnEditedFileDisplayStatus,
  turnResetConfirmPrompt,
  turnResetWorkspaceNote,
} from './turn-edits-footer';

const files: TurnEditedFile[] = [
  { relativePath: 'src/a.py', op: 'modify', additions: 3, deletions: 1, status: 'kept' },
  { relativePath: 'b.txt', op: 'create', additions: 2, deletions: 0, status: 'kept' },
];

describe('turn-edits-footer helpers', () => {
  it('derives the row status from persisted status and the live disk check', () => {
    const kept = files[0]!;
    expect(turnEditedFileDisplayStatus(kept, undefined)).toBe('kept');
    expect(turnEditedFileDisplayStatus(kept, { ...kept, changedSinceTurn: true })).toBe('changed');
    expect(turnEditedFileDisplayStatus({ ...kept, status: 'reset' }, { ...kept, changedSinceTurn: true })).toBe(
      'reset',
    );
  });

  it('splits a path into name and folder', () => {
    expect(splitTurnFilePath('src/lib/a.py')).toEqual({ name: 'a.py', dir: 'src/lib' });
    expect(splitTurnFilePath('a.py')).toEqual({ name: 'a.py', dir: '' });
  });

  it('formats the reset note sent to the agent', () => {
    expect(turnResetWorkspaceNote('a.py', 3)).toBe('User reset `a.py` from turn 3 to its pre-edit state');
  });

  it('formats the reset confirmation for one file and for Reset all', () => {
    expect(turnResetConfirmPrompt('a.py', 3)).toMatchObject({
      title: 'Reset file?',
      message: 'Restore "a.py" to its state before turn 3? Changes made since then will be lost.',
      confirmText: 'Reset',
      variant: 'warning',
    });
    expect(turnResetConfirmPrompt(null, 3)).toMatchObject({ title: 'Reset all files?', confirmText: 'Reset all' });
  });
});

describe('TurnEditsFooterComponent', () => {
  let electron: {
    listTurnFiles: ReturnType<typeof vi.fn>;
    resetTurnFiles: ReturnType<typeof vi.fn>;
  };
  let session: {
    applyTurnEditedFiles: ReturnType<typeof vi.fn>;
    queueWorkspaceNote: ReturnType<typeof vi.fn>;
  };
  let themedConfirm: { open: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    themedConfirm = { open: vi.fn(async () => 'confirm') };
    electron = {
      listTurnFiles: vi.fn(async (): Promise<TurnEditedFileRow[]> => files.map((f) => ({ ...f, changedSinceTurn: false }))),
      resetTurnFiles: vi.fn(),
    };
    session = { applyTurnEditedFiles: vi.fn(), queueWorkspaceNote: vi.fn() };
    TestBed.configureTestingModule({
      imports: [TurnEditsFooterComponent],
      providers: [
        ...lucideAppProviders,
        { provide: ElectronService, useValue: electron },
        { provide: ConversationSessionService, useValue: session },
        { provide: ThemedConfirmDialogService, useValue: themedConfirm },
      ],
    });
  });

  function mount(input: readonly TurnEditedFile[] = files) {
    const fixture = TestBed.createComponent(TurnEditsFooterComponent);
    fixture.componentRef.setInput('conversationId', 'c1');
    fixture.componentRef.setInput('userMessageId', 'u1');
    fixture.componentRef.setInput('turnNumber', 2);
    fixture.componentRef.setInput('files', input);
    fixture.detectChanges();
    return { fixture, host: fixture.nativeElement as HTMLElement, cmp: fixture.componentInstance };
  }

  async function settle(fixture: ReturnType<typeof mount>['fixture']): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('shows a collapsed "N files edited +a −d" header with Reset all', () => {
    const { host } = mount();
    expect(host.querySelector('.turn-edits__title')?.textContent?.trim()).toBe('2 files edited');
    expect(host.querySelector('.turn-edits__header .turn-edits__add')?.textContent?.trim()).toBe('+5');
    expect(host.querySelector('.turn-edits__header .turn-edits__del')?.textContent?.trim()).toBe('−1');
    expect(host.querySelector('.turn-edits__reset-all')).toBeTruthy();
    expect(host.querySelector('.turn-edits__list')).toBeNull();
  });

  it('expands into rows and marks files changed since the turn', async () => {
    electron.listTurnFiles.mockResolvedValue([
      { ...files[0]!, changedSinceTurn: true },
      { ...files[1]!, changedSinceTurn: false },
    ]);
    const { fixture, host } = mount();
    (host.querySelector('.turn-edits__toggle') as HTMLButtonElement).click();
    await settle(fixture);

    expect(electron.listTurnFiles).toHaveBeenCalledWith('c1', 'u1');
    const rows = host.querySelectorAll('.turn-edits__row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.turn-edits__name')?.textContent?.trim()).toBe('a.py');
    expect(rows[0]?.querySelector('.turn-edits__status')?.textContent?.trim()).toBe('changed since');
    expect(rows[1]?.querySelector('.turn-edits__status')?.textContent?.trim()).toBe('kept');
  });

  it('emits openDiff when a row is clicked', async () => {
    const { fixture, host, cmp } = mount();
    const opened = vi.fn();
    cmp.openDiff.subscribe(opened);
    (host.querySelector('.turn-edits__toggle') as HTMLButtonElement).click();
    await settle(fixture);
    (host.querySelector('.turn-edits__open') as HTMLButtonElement).click();
    expect(opened).toHaveBeenCalledWith({ userMessageId: 'u1', relativePath: 'src/a.py', turnNumber: 2 });
  });

  it('resets one file, mirrors statuses and queues a note for the agent', async () => {
    const after: TurnEditedFile[] = [{ ...files[0]!, status: 'reset' }, files[1]!];
    electron.resetTurnFiles.mockResolvedValue({
      ok: true,
      resetPaths: ['src/a.py'],
      skippedPaths: [],
      files: after,
    } satisfies ResetTurnFilesResult);
    const { fixture, host } = mount();
    (host.querySelector('.turn-edits__toggle') as HTMLButtonElement).click();
    await settle(fixture);

    (host.querySelector('.turn-edits__reset') as HTMLButtonElement).click();
    await settle(fixture);

    expect(themedConfirm.open).toHaveBeenCalledWith(turnResetConfirmPrompt('src/a.py', 2));
    expect(electron.resetTurnFiles).toHaveBeenCalledWith({
      conversationId: 'c1',
      userMessageId: 'u1',
      paths: ['src/a.py'],
      force: false,
    });
    expect(session.applyTurnEditedFiles).toHaveBeenCalledWith('u1', after);
    expect(session.queueWorkspaceNote).toHaveBeenCalledWith(
      'c1',
      'User reset `src/a.py` from turn 2 to its pre-edit state',
    );
  });

  it('does nothing when the reset confirmation is cancelled', async () => {
    themedConfirm.open.mockResolvedValue('cancel');
    const { fixture, host } = mount();

    (host.querySelector('.turn-edits__reset-all') as HTMLButtonElement).click();
    await settle(fixture);

    expect(themedConfirm.open).toHaveBeenCalledWith(turnResetConfirmPrompt(null, 2));
    expect(electron.resetTurnFiles).not.toHaveBeenCalled();
    expect(session.applyTurnEditedFiles).not.toHaveBeenCalled();
  });

  it('asks to overwrite on conflict and retries with force', async () => {
    electron.resetTurnFiles
      .mockResolvedValueOnce({ ok: false, conflicts: ['src/a.py'], error: 'Some files changed since this turn.' })
      .mockResolvedValueOnce({ ok: true, resetPaths: ['src/a.py', 'b.txt'], skippedPaths: [], files });
    const { fixture, host } = mount();

    (host.querySelector('.turn-edits__reset-all') as HTMLButtonElement).click();
    await settle(fixture);

    const conflict = host.querySelector('.turn-edits__conflict');
    expect(conflict?.textContent).toContain('Changed since this turn — overwrite?');
    expect(session.applyTurnEditedFiles).not.toHaveBeenCalled();

    (conflict?.querySelector('.hitl-btn--danger-outline') as HTMLButtonElement).click();
    await settle(fixture);

    expect(electron.resetTurnFiles).toHaveBeenLastCalledWith({ conversationId: 'c1', userMessageId: 'u1', force: true });
    expect(host.querySelector('.turn-edits__conflict')).toBeNull();
    expect(session.queueWorkspaceNote).toHaveBeenCalledTimes(2);
  });

  it('hides reset controls once every file is reset', () => {
    const { host } = mount(files.map((f) => ({ ...f, status: 'reset' as const })));
    expect(host.querySelector('.turn-edits__reset-all')).toBeNull();
  });
});
