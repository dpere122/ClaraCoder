import { mkdirSync, readdirSync, readFileSync, existsSync } from 'fs';
import path = require('path');
/** CJS interop: default import compiles to `.default`, which better-sqlite3 does not set. */
import DatabaseConstructor = require('better-sqlite3');
import type { ConversationFile, ConversationMeta, ConversationSummary } from '../shared';
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
      (id, workspace_id, title, created_at, updated_at, theme_id, messages_json)
     VALUES (@id, @workspace_id, @title, @created_at, @updated_at, @theme_id, @messages_json)`,
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
            `SELECT id, workspace_id, title, created_at, updated_at, theme_id, messages_json
             FROM conversations
             WHERE workspace_id IS NULL
             ORDER BY updated_at DESC`,
          )
          .all() as ConversationRow[])
      : (database
          .prepare(
            `SELECT id, workspace_id, title, created_at, updated_at, theme_id, messages_json
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
  }));
}

export function getConversationById(id: string): ConversationFile | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT id, workspace_id, title, created_at, updated_at, theme_id, messages_json
       FROM conversations WHERE id = ?`,
    )
    .get(id) as ConversationRow | undefined;
  return row ? rowToConversationFile(row) : null;
}

export function upsertConversation(conv: ConversationFile): void {
  const database = getDb();
  const existing = database
    .prepare('SELECT theme_id FROM conversations WHERE id = ?')
    .get(conv.id) as { theme_id: string } | undefined;
  if (existing) {
    conv.themeId = existing.theme_id || FIRST_THEME_ID;
  } else if (!conv.themeId) {
    conv.themeId = FIRST_THEME_ID;
  }

  database
    .prepare(
      `INSERT INTO conversations
        (id, workspace_id, title, created_at, updated_at, theme_id, messages_json)
       VALUES (@id, @workspace_id, @title, @created_at, @updated_at, @theme_id, @messages_json)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         title = excluded.title,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         theme_id = excluded.theme_id,
         messages_json = excluded.messages_json`,
    )
    .run({
      id: conv.id,
      workspace_id: conv.workspaceId,
      title: conv.title,
      created_at: conv.createdAt,
      updated_at: conv.updatedAt,
      theme_id: conv.themeId,
      messages_json: JSON.stringify(conv.messages),
    });
}

export function deleteConversationById(id: string): void {
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function updateConversationTitle(id: string, title: string, updatedAt: string): void {
  getDb()
    .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, updatedAt, id);
}

export function updateConversationTheme(id: string, themeId: string, updatedAt: string): void {
  getDb()
    .prepare('UPDATE conversations SET theme_id = ?, updated_at = ? WHERE id = ?')
    .run(themeId, updatedAt, id);
}

export function getRecentConversationSummaries(limit: number): ConversationSummary[] {
  const rows = getDb()
    .prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as SummaryRow[];
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
}
