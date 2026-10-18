import { mkdirSync, readdirSync, readFileSync, existsSync } from 'fs';
import path = require('path');
/** CJS interop: default import compiles to `.default`, which better-sqlite3 does not set. */
import DatabaseConstructor = require('better-sqlite3');
import type {
  AppendConversationFileJournalRequest,
  ConversationFile,
  ConversationFileJournalEntry,
  ConversationFileJournalOp,
  ConversationMeta,
  ConversationSummary,
  TurnEditedFileStatus,
} from '../shared';
import { isConversationFileJournalOp } from '../shared';
import { FIRST_THEME_ID } from './constants';
import {
  getAppDataDir,
  getConversationsDbPath,
  getGeneralConversationsDir,
  getWorkspacesDir,
} from './paths';

const META_KEY_MIGRATED = 'migrated_from_json';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

let db: SqliteDatabase | null = null;

function customTitleFromSqlite(v: number | undefined | null): boolean {
  return v === 1;
}

function rowToConversationFile(row: ConversationRow): ConversationFile {
  let messages: ConversationFile['messages'];
  try {
    messages = JSON.parse(row.messages_json) as ConversationFile['messages'];
  } catch {
    messages = [];
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
    workspaceId: row.workspace_id,
    themeId: row.theme_id || FIRST_THEME_ID,
    customTitle: customTitleFromSqlite(row.custom_title),
  };
}

interface ConversationRow {
  id: string;
  workspace_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  theme_id: string;
  messages_json: string;
  custom_title: number;
}

interface SummaryRow {
  id: string;
  title: string;
  updated_at: string;
}

function migrateSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      messages_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_workspace_updated
      ON conversations (workspace_id, updated_at DESC);
  `);
}

function migrateFileJournalTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_file_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      op TEXT NOT NULL,
      before_content TEXT,
      before_encoding TEXT,
      before_newline TEXT,
      dest_relative_path TEXT,
      tree_entries_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_file_journal_conv_seq
      ON conversation_file_journal (conversation_id, seq);
  `);
}

function migrateTurnFilesTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_turn_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      op TEXT NOT NULL,
      before_content TEXT,
      before_existed INTEGER NOT NULL DEFAULT 0,
      after_content TEXT,
      after_exists INTEGER NOT NULL DEFAULT 0,
      encoding TEXT,
      newline TEXT,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'kept'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_files_conv_turn_path
      ON conversation_turn_files (conversation_id, user_message_id, relative_path);
  `);
}

/** Add custom_title when upgrading from older DBs (idempotent). */
function migrateCustomTitleColumn(database: SqliteDatabase): void {
  const cols = database.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'custom_title')) {
    return;
  }
  database.exec(
    'ALTER TABLE conversations ADD COLUMN custom_title INTEGER NOT NULL DEFAULT 0',
  );
}

function isMigrated(database: SqliteDatabase): boolean {
  const row = database
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get(META_KEY_MIGRATED) as { value: string } | undefined;
  return row?.value === '1';
}

function importLegacyJsonIfNeeded(database: SqliteDatabase): void {
  if (isMigrated(database)) {
    return;
  }

  const insert = database.prepare(
    `INSERT OR REPLACE INTO conversations
      (id, workspace_id, title, created_at, updated_at, theme_id, messages_json, custom_title)
     VALUES (@id, @workspace_id, @title, @created_at, @updated_at, @theme_id, @messages_json, @custom_title)`,
  );

  const importFile = (filePath: string, folderWorkspaceId: string | null): void => {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const conv = JSON.parse(raw) as Partial<ConversationFile>;
      if (typeof conv.id !== 'string' || !Array.isArray(conv.messages)) {
        return;
      }
      const wsFromFile = conv.workspaceId;
      const workspaceId =
        typeof wsFromFile === 'string' && wsFromFile.length > 0 ? wsFromFile : folderWorkspaceId;

      insert.run({
        id: conv.id,
        workspace_id: workspaceId,
        title: typeof conv.title === 'string' ? conv.title : 'Conversation',
        created_at: typeof conv.createdAt === 'string' ? conv.createdAt : new Date().toISOString(),
        updated_at: typeof conv.updatedAt === 'string' ? conv.updatedAt : new Date().toISOString(),
        theme_id: typeof conv.themeId === 'string' ? conv.themeId : FIRST_THEME_ID,
        messages_json: JSON.stringify(conv.messages),
        custom_title: conv.customTitle ? 1 : 0,
      });
    } catch {
      // skip malformed files
    }
  };

  const generalDir = getGeneralConversationsDir();
  if (existsSync(generalDir)) {
    try {
      for (const f of readdirSync(generalDir)) {
        if (!f.endsWith('.json')) continue;
        importFile(path.join(generalDir, f), null);
      }
    } catch {
      // ignore
    }
  }

  const wsRoot = getWorkspacesDir();
  if (existsSync(wsRoot)) {
    try {
      const entries = readdirSync(wsRoot, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const convDir = path.join(wsRoot, e.name, 'conversations');
        if (!existsSync(convDir)) continue;
        try {
          for (const f of readdirSync(convDir)) {
            if (!f.endsWith('.json')) continue;
            importFile(path.join(convDir, f), e.name);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  database
    .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
    .run(META_KEY_MIGRATED, '1');
}

/** Open DB, apply schema, and one-time JSON import. Idempotent. */
export function openConversationsDb(): void {
  if (db) {
    return;
  }
  mkdirSync(getAppDataDir(), { recursive: true });
  const database = new DatabaseConstructor(getConversationsDbPath());
  database.pragma('journal_mode = WAL');
  migrateSchema(database);
  migrateCustomTitleColumn(database);
  migrateFileJournalTable(database);
  migrateTurnFilesTable(database);
  importLegacyJsonIfNeeded(database);
  db = database;
}

function getDb(): SqliteDatabase {
  if (!db) {
    throw new Error('Conversations database not initialised; call openConversationsDb() first');
  }
  return db;
}

/** `workspaceId === null` lists conversations with no workspace (legacy general bucket). */
export function getConversationMetas(workspaceId: string | null): ConversationMeta[] {
  const database = getDb();
  const rows =
    workspaceId === null
      ? (database
          .prepare(
            `SELECT id, workspace_id, title, created_at, updated_at, theme_id, messages_json, custom_title
             FROM conversations
             WHERE workspace_id IS NULL
             ORDER BY updated_at DESC`,
          )
          .all() as ConversationRow[])
      : (database
          .prepare(
            `SELECT id, workspace_id, title, created_at, updated_at, theme_id, messages_json, custom_title
             FROM conversations
             WHERE workspace_id = ?
             ORDER BY updated_at DESC`,
          )
          .all(workspaceId) as ConversationRow[]);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    workspaceId: r.workspace_id,
    customTitle: customTitleFromSqlite(r.custom_title),
  }));
}

export function getConversationById(id: string): ConversationFile | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT id, workspace_id, title, created_at, updated_at, theme_id, messages_json, custom_title
       FROM conversations WHERE id = ?`,
    )
    .get(id) as ConversationRow | undefined;
  return row ? rowToConversationFile(row) : null;
}

export function upsertConversation(conv: ConversationFile): void {
  const database = getDb();
  const existing = database
    .prepare('SELECT theme_id, custom_title FROM conversations WHERE id = ?')
    .get(conv.id) as { theme_id: string; custom_title: number } | undefined;
  if (existing) {
    conv.themeId = existing.theme_id || FIRST_THEME_ID;
    if (existing.custom_title === 1) {
      conv.customTitle = true;
    }
  } else if (!conv.themeId) {
    conv.themeId = FIRST_THEME_ID;
  }

  database
    .prepare(
      `INSERT INTO conversations
        (id, workspace_id, title, created_at, updated_at, theme_id, messages_json, custom_title)
       VALUES (@id, @workspace_id, @title, @created_at, @updated_at, @theme_id, @messages_json, @custom_title)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         title = excluded.title,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         theme_id = excluded.theme_id,
         messages_json = excluded.messages_json,
         custom_title = excluded.custom_title`,
    )
    .run({
      id: conv.id,
      workspace_id: conv.workspaceId,
      title: conv.title,
      created_at: conv.createdAt,
      updated_at: conv.updatedAt,
      theme_id: conv.themeId,
      messages_json: JSON.stringify(conv.messages),
      custom_title: conv.customTitle ? 1 : 0,
    });
}

export function deleteConversationById(id: string): void {
  const database = getDb();
  database.prepare('DELETE FROM conversation_file_journal WHERE conversation_id = ?').run(id);
  database.prepare('DELETE FROM conversation_turn_files WHERE conversation_id = ?').run(id);
  database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

/** Conversation ids stored under a workspace (empty when none). */
export function listConversationIdsByWorkspaceId(workspaceId: string): string[] {
  const id = workspaceId.trim();
  if (!id) {
    return [];
  }
  const rows = getDb()
    .prepare('SELECT id FROM conversations WHERE workspace_id = ?')
    .all(id) as { id: string }[];
  return rows.map((row) => row.id);
}

/** Distinct non-null workspace ids that still have conversation rows. */
export function listDistinctConversationWorkspaceIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT workspace_id FROM conversations
       WHERE workspace_id IS NOT NULL AND workspace_id != ''`,
    )
    .all() as { workspace_id: string }[];
  return rows.map((row) => row.workspace_id);
}

/** Delete all conversations (and file-journal rows) for a workspace. Returns removed ids. */
export function deleteConversationsByWorkspaceId(workspaceId: string): string[] {
  const ids = listConversationIdsByWorkspaceId(workspaceId);
  if (ids.length === 0) {
    return [];
  }
  const database = getDb();
  const deleteJournal = database.prepare('DELETE FROM conversation_file_journal WHERE conversation_id = ?');
  const deleteTurnFiles = database.prepare('DELETE FROM conversation_turn_files WHERE conversation_id = ?');
  const deleteConv = database.prepare('DELETE FROM conversations WHERE id = ?');
  const tx = database.transaction(() => {
    for (const id of ids) {
      deleteJournal.run(id);
      deleteTurnFiles.run(id);
      deleteConv.run(id);
    }
  });
  tx();
  return ids;
}

interface FileJournalRow {
  conversation_id: string;
  user_message_id: string;
  seq: number;
  relative_path: string;
  op: string;
  before_content: string | null;
  before_encoding: string | null;
  before_newline: string | null;
  dest_relative_path: string | null;
  tree_entries_json: string | null;
}

function rowToJournalEntry(row: FileJournalRow): ConversationFileJournalEntry {
  let treeEntries: ConversationFileJournalEntry['treeEntries'];
  if (row.tree_entries_json) {
    try {
      treeEntries = JSON.parse(row.tree_entries_json) as ConversationFileJournalEntry['treeEntries'];
    } catch {
      treeEntries = undefined;
    }
  }
  const op: ConversationFileJournalOp = isConversationFileJournalOp(row.op) ? row.op : 'modify';
  return {
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    seq: row.seq,
    relativePath: row.relative_path,
    op,
    beforeContent: row.before_content,
    beforeEncoding: row.before_encoding ?? undefined,
    beforeNewline: row.before_newline === 'crlf' ? 'crlf' : row.before_newline === 'lf' ? 'lf' : undefined,
    destRelativePath: row.dest_relative_path ?? undefined,
    treeEntries,
  };
}

export function appendConversationFileJournal(req: AppendConversationFileJournalRequest): ConversationFileJournalEntry {
  const database = getDb();
  const next = database
    .prepare(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
       FROM conversation_file_journal WHERE conversation_id = ?`,
    )
    .get(req.conversationId) as { next_seq: number };
  const seq = Number(next?.next_seq ?? 0);
  database
    .prepare(
      `INSERT INTO conversation_file_journal
        (conversation_id, user_message_id, seq, relative_path, op, before_content,
         before_encoding, before_newline, dest_relative_path, tree_entries_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.conversationId,
      req.userMessageId,
      seq,
      req.relativePath,
      req.op,
      req.beforeContent ?? null,
      req.beforeEncoding ?? null,
      req.beforeNewline ?? null,
      req.destRelativePath ?? null,
      req.treeEntries?.length ? JSON.stringify(req.treeEntries) : null,
    );
  return {
    conversationId: req.conversationId,
    userMessageId: req.userMessageId,
    seq,
    relativePath: req.relativePath,
    op: req.op,
    beforeContent: req.beforeContent,
    beforeEncoding: req.beforeEncoding,
    beforeNewline: req.beforeNewline,
    destRelativePath: req.destRelativePath,
    treeEntries: req.treeEntries,
  };
}

export function listConversationFileJournal(conversationId: string): ConversationFileJournalEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT conversation_id, user_message_id, seq, relative_path, op, before_content,
              before_encoding, before_newline, dest_relative_path, tree_entries_json
       FROM conversation_file_journal
       WHERE conversation_id = ?
       ORDER BY seq ASC`,
    )
    .all(conversationId) as FileJournalRow[];
  return rows.map(rowToJournalEntry);
}

export function deleteConversationFileJournalForUserIds(conversationId: string, userMessageIds: readonly string[]): void {
  if (userMessageIds.length === 0) {
    return;
  }
  const database = getDb();
  const stmt = database.prepare(
    'DELETE FROM conversation_file_journal WHERE conversation_id = ? AND user_message_id = ?',
  );
  const turnFilesStmt = database.prepare(
    'DELETE FROM conversation_turn_files WHERE conversation_id = ? AND user_message_id = ?',
  );
  const tx = database.transaction(() => {
    for (const id of userMessageIds) {
      stmt.run(conversationId, id);
      turnFilesStmt.run(conversationId, id);
    }
  });
  tx();
}

/** Journal rows for one user turn, oldest first. */
export function listConversationFileJournalForTurn(
  conversationId: string,
  userMessageId: string,
): ConversationFileJournalEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT conversation_id, user_message_id, seq, relative_path, op, before_content,
              before_encoding, before_newline, dest_relative_path, tree_entries_json
       FROM conversation_file_journal
       WHERE conversation_id = ? AND user_message_id = ?
       ORDER BY seq ASC`,
    )
    .all(conversationId, userMessageId) as FileJournalRow[];
  return rows.map(rowToJournalEntry);
}

/** One path a user turn wrote: before/after snapshots for end-of-turn review and reset. */
export interface ConversationTurnFileRecord {
  conversationId: string;
  userMessageId: string;
  relativePath: string;
  op: ConversationFileJournalOp;
  beforeContent: string | null;
  beforeExisted: boolean;
  afterContent: string | null;
  afterExists: boolean;
  encoding?: string;
  newline?: 'lf' | 'crlf';
  additions: number;
  deletions: number;
  status: TurnEditedFileStatus;
}

interface TurnFileRow {
  conversation_id: string;
  user_message_id: string;
  relative_path: string;
  op: string;
  before_content: string | null;
  before_existed: number;
  after_content: string | null;
  after_exists: number;
  encoding: string | null;
  newline: string | null;
  additions: number;
  deletions: number;
  status: string;
}

function rowToTurnFileRecord(row: TurnFileRow): ConversationTurnFileRecord {
  return {
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    relativePath: row.relative_path,
    op: isConversationFileJournalOp(row.op) ? row.op : 'modify',
    beforeContent: row.before_content,
    beforeExisted: row.before_existed === 1,
    afterContent: row.after_content,
    afterExists: row.after_exists === 1,
    encoding: row.encoding ?? undefined,
    newline: row.newline === 'crlf' ? 'crlf' : row.newline === 'lf' ? 'lf' : undefined,
    additions: Number(row.additions) || 0,
    deletions: Number(row.deletions) || 0,
    status: row.status === 'reset' ? 'reset' : 'kept',
  };
}

/** Insert or refresh turn-file rows (a re-finalized path goes back to its given status). */
export function upsertConversationTurnFiles(records: readonly ConversationTurnFileRecord[]): void {
  if (records.length === 0) {
    return;
  }
  const database = getDb();
  const stmt = database.prepare(
    `INSERT INTO conversation_turn_files
      (conversation_id, user_message_id, relative_path, op, before_content, before_existed,
       after_content, after_exists, encoding, newline, additions, deletions, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_message_id, relative_path) DO UPDATE SET
       op = excluded.op,
       before_content = excluded.before_content,
       before_existed = excluded.before_existed,
       after_content = excluded.after_content,
       after_exists = excluded.after_exists,
       encoding = excluded.encoding,
       newline = excluded.newline,
       additions = excluded.additions,
       deletions = excluded.deletions,
       status = excluded.status`,
  );
  const tx = database.transaction(() => {
    for (const r of records) {
      stmt.run(
        r.conversationId,
        r.userMessageId,
        r.relativePath,
        r.op,
        r.beforeContent,
        r.beforeExisted ? 1 : 0,
        r.afterContent,
        r.afterExists ? 1 : 0,
        r.encoding ?? null,
        r.newline ?? null,
        r.additions,
        r.deletions,
        r.status,
      );
    }
  });
  tx();
}

export function listConversationTurnFiles(
  conversationId: string,
  userMessageId: string,
): ConversationTurnFileRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT conversation_id, user_message_id, relative_path, op, before_content, before_existed,
              after_content, after_exists, encoding, newline, additions, deletions, status
       FROM conversation_turn_files
       WHERE conversation_id = ? AND user_message_id = ?
       ORDER BY id ASC`,
    )
    .all(conversationId, userMessageId) as TurnFileRow[];
  return rows.map(rowToTurnFileRecord);
}

export function setConversationTurnFilesStatus(
  conversationId: string,
  userMessageId: string,
  relativePaths: readonly string[],
  status: TurnEditedFileStatus,
): void {
  if (relativePaths.length === 0) {
    return;
  }
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE conversation_turn_files SET status = ?
     WHERE conversation_id = ? AND user_message_id = ? AND relative_path = ?`,
  );
  const tx = database.transaction(() => {
    for (const p of relativePaths) {
      stmt.run(status, conversationId, userMessageId, p);
    }
  });
  tx();
}

export function updateConversationTitle(id: string, title: string, updatedAt: string): void {
  getDb()
    .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, updatedAt, id);
}

/** User rename: persist title and lock against model auto-title updates. */
export function updateConversationTitleAndLock(id: string, title: string, updatedAt: string): void {
  getDb()
    .prepare('UPDATE conversations SET title = ?, updated_at = ?, custom_title = 1 WHERE id = ?')
    .run(title, updatedAt, id);
}

/** Model-suggested title only when not user-locked. */
export function updateAutoConversationTitle(id: string, title: string, updatedAt: string): boolean {
  const res = getDb()
    .prepare(
      'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND custom_title = 0',
    )
    .run(title, updatedAt, id);
  return res.changes > 0;
}

export function updateConversationTheme(id: string, themeId: string, updatedAt: string): void {
  getDb()
    .prepare('UPDATE conversations SET theme_id = ?, updated_at = ? WHERE id = ?')
    .run(themeId, updatedAt, id);
}

/** Close the module DB (tests only). */
export function closeConversationsDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Open a dedicated SQLite file (tests only). */
export function openConversationsDbForTests(dbPath: string): void {
  closeConversationsDbForTests();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseConstructor(dbPath);
  database.pragma('journal_mode = WAL');
  migrateSchema(database);
  migrateCustomTitleColumn(database);
  migrateFileJournalTable(database);
  migrateTurnFilesTable(database);
  db = database;
}

export function getRecentConversationSummaries(limit: number): ConversationSummary[] {
  const rows = getDb()
    .prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as SummaryRow[];
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
}
