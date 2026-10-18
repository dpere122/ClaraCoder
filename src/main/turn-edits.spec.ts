import { mkdtempSync, promises as fs, rmSync } from 'fs';
import { tmpdir } from 'os';
import path = require('path');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppendConversationFileJournalRequest, ConversationFileJournalEntry } from '../shared';
import type { ConversationTurnFileRecord } from './conversations-db';

const journal: ConversationFileJournalEntry[] = [];
const turnFiles: ConversationTurnFileRecord[] = [];

vi.mock('./workspace/emit-files-changed', () => ({
  emitWorkspaceFilesChanged: vi.fn(async () => undefined),
}));

vi.mock('./conversations-db', () => ({
  listConversationFileJournalForTurn: (conversationId: string, userMessageId: string) =>
    journal.filter((e) => e.conversationId === conversationId && e.userMessageId === userMessageId),
  listConversationTurnFiles: (conversationId: string, userMessageId: string) =>
    turnFiles
      .filter((r) => r.conversationId === conversationId && r.userMessageId === userMessageId)
      .map((r) => ({ ...r })),
  upsertConversationTurnFiles: (records: ConversationTurnFileRecord[]) => {
    for (const r of records) {
      const i = turnFiles.findIndex(
        (x) =>
          x.conversationId === r.conversationId &&
          x.userMessageId === r.userMessageId &&
          x.relativePath === r.relativePath,
      );
      if (i >= 0) {
        turnFiles[i] = { ...r };
      } else {
        turnFiles.push({ ...r });
      }
    }
  },
  setConversationTurnFilesStatus: (
    conversationId: string,
    userMessageId: string,
    paths: string[],
    status: 'kept' | 'reset',
  ) => {
    for (const r of turnFiles) {
      if (r.conversationId === conversationId && r.userMessageId === userMessageId && paths.includes(r.relativePath)) {
        r.status = status;
      }
    }
  },
}));

import { finalizeTurnEdits, getTurnFileDiff, listTurnFiles, resetTurnFiles } from './turn-edits';

function addJournal(req: Omit<AppendConversationFileJournalRequest, 'conversationId'>, conversationId = 'c1'): void {
  journal.push({ conversationId, seq: journal.length, ...req });
}

describe('turn-edits', () => {
  let root: string;

  beforeEach(() => {
    journal.length = 0;
    turnFiles.length = 0;
    root = mkdtempSync(path.join(tmpdir(), 'clara-turn-edits-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function write(rel: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text, 'utf8');
  }

  async function read(rel: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  }

  describe('finalizeTurnEdits', () => {
    it('snapshots the first journal row per path against current disk with +/- counts', async () => {
      addJournal({ userMessageId: 'u1', op: 'modify', relativePath: 'a.py', beforeContent: 'one\ntwo\nthree\n' });
      // A later write in the same turn must not replace the "before" side.
      addJournal({ userMessageId: 'u1', op: 'modify', relativePath: 'a.py', beforeContent: 'intermediate\n' });
      addJournal({ userMessageId: 'u1', op: 'create', relativePath: 'src/new.ts', beforeContent: null });
      addJournal({ userMessageId: 'u2', op: 'modify', relativePath: 'other.py', beforeContent: 'x\n' });
      await write('a.py', 'one\nTWO\nthree\nfour\n');
      await write('src/new.ts', 'export const x = 1;\n');

      const summary = await finalizeTurnEdits('c1', 'u1', root);

      expect(summary).toEqual([
        { relativePath: 'a.py', op: 'modify', additions: 2, deletions: 1, status: 'kept' },
        { relativePath: 'src/new.ts', op: 'create', additions: 1, deletions: 0, status: 'kept' },
      ]);
      const diff = getTurnFileDiff('c1', 'u1', 'a.py');
      expect(diff).toEqual(
        expect.objectContaining({ ok: true, before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\nfour\n' }),
      );
    });

    it('records deletes and drops paths with no net change', async () => {
      addJournal({ userMessageId: 'u1', op: 'delete', relativePath: 'gone.txt', beforeContent: 'a\nb\n' });
      addJournal({ userMessageId: 'u1', op: 'modify', relativePath: 'same.txt', beforeContent: 'keep\n' });
      await write('same.txt', 'keep\n');

      const summary = await finalizeTurnEdits('c1', 'u1', root);

      expect(summary).toEqual([{ relativePath: 'gone.txt', op: 'delete', additions: 0, deletions: 2, status: 'kept' }]);
      expect(turnFiles[0]).toEqual(expect.objectContaining({ afterExists: false, beforeExisted: true }));
    });

    it('normalizes CRLF on disk to LF before comparing', async () => {
      addJournal({
        userMessageId: 'u1',
        op: 'modify',
        relativePath: 'win.txt',
        beforeContent: 'a\nb\n',
        beforeNewline: 'crlf',
      });
      await write('win.txt', 'a\r\nB\r\n');

      const [row] = await finalizeTurnEdits('c1', 'u1', root);

      expect(row).toEqual(expect.objectContaining({ additions: 1, deletions: 1 }));
      expect(turnFiles[0]?.afterContent).toBe('a\nB\n');
    });

    it('returns nothing without a journal or workspace root', async () => {
      expect(await finalizeTurnEdits('c1', 'u1', root)).toEqual([]);
      addJournal({ userMessageId: 'u1', op: 'create', relativePath: 'x.txt' });
      expect(await finalizeTurnEdits('c1', 'u1', '')).toEqual([]);
    });
  });

  describe('resetTurnFiles', () => {
    async function finalizedTurn(): Promise<void> {
      addJournal({ userMessageId: 'u1', op: 'modify', relativePath: 'a.py', beforeContent: 'old\n' });
      addJournal({ userMessageId: 'u1', op: 'create', relativePath: 'b.py', beforeContent: null });
      await write('a.py', 'new\n');
      await write('b.py', 'created\n');
      await finalizeTurnEdits('c1', 'u1', root);
    }

    it('reverts every kept path when disk still matches the turn', async () => {
      await finalizedTurn();

      const res = await resetTurnFiles({ conversationId: 'c1', userMessageId: 'u1' }, root);

      expect(res.ok).toBe(true);
      expect(res.ok && res.resetPaths.sort()).toEqual(['a.py', 'b.py']);
      expect(res.ok && res.files.every((f) => f.status === 'reset')).toBe(true);
      expect(await read('a.py')).toBe('old\n');
      expect(await read('b.py')).toBeNull();
    });

    it('reports conflicts without writing when disk changed since the turn', async () => {
      await finalizedTurn();
      await write('a.py', 'edited by hand\n');

      const res = await resetTurnFiles({ conversationId: 'c1', userMessageId: 'u1', paths: ['a.py'] }, root);

      expect(res).toEqual(expect.objectContaining({ ok: false, conflicts: ['a.py'] }));
      expect(await read('a.py')).toBe('edited by hand\n');
      expect(turnFiles.find((r) => r.relativePath === 'a.py')?.status).toBe('kept');
      const rows = await listTurnFiles('c1', 'u1', root);
      expect(rows.find((r) => r.relativePath === 'a.py')?.changedSinceTurn).toBe(true);
      expect(rows.find((r) => r.relativePath === 'b.py')?.changedSinceTurn).toBe(false);
    });

    it('treats a re-created deleted file as a conflict', async () => {
      addJournal({ userMessageId: 'u1', op: 'delete', relativePath: 'gone.txt', beforeContent: 'a\n' });
      await finalizeTurnEdits('c1', 'u1', root);
      await write('gone.txt', 'recreated\n');

      const res = await resetTurnFiles({ conversationId: 'c1', userMessageId: 'u1' }, root);

      expect(res).toEqual(expect.objectContaining({ ok: false, conflicts: ['gone.txt'] }));
    });

    it('overwrites conflicting paths with force and only resets the requested paths', async () => {
      await finalizedTurn();
      await write('a.py', 'edited by hand\n');

      const res = await resetTurnFiles(
        { conversationId: 'c1', userMessageId: 'u1', paths: ['a.py'], force: true },
        root,
      );

      expect(res.ok && res.resetPaths).toEqual(['a.py']);
      expect(await read('a.py')).toBe('old\n');
      expect(await read('b.py')).toBe('created\n');
      expect(turnFiles.find((r) => r.relativePath === 'b.py')?.status).toBe('kept');
    });

    it('skips paths already reset and fails without a workspace root', async () => {
      await finalizedTurn();
      await resetTurnFiles({ conversationId: 'c1', userMessageId: 'u1', paths: ['a.py'] }, root);

      const again = await resetTurnFiles({ conversationId: 'c1', userMessageId: 'u1', paths: ['a.py'] }, root);
      expect(again.ok && again.resetPaths).toEqual([]);

      const noRoot = await resetTurnFiles({ conversationId: 'c1', userMessageId: 'u1' }, null);
      expect(noRoot.ok).toBe(false);
    });
  });
});
