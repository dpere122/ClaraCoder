import { ipcMain } from 'electron';
import type { LspDashboardStatus } from '../../../shared';
import { isSemanticLegendServerId } from '../../../shared/lsp-registry';
import { pythonControlFetch } from '../../python/http-client';

interface LspEditorIRangeWire {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface LspEditorLocationWire {
  relativePath: string;
  range: LspEditorIRangeWire;
}

interface LspEditorDocumentSymbolWire {
  name: string;
  kind?: number;
  detail?: string;
  range: LspEditorIRangeWire;
  selectionRange: LspEditorIRangeWire;
  children?: LspEditorDocumentSymbolWire[];
}

interface LspEditorFlatSymbolWire {
  name: string;
  kind?: number;
  containerName?: string;
  relativePath: string;
  range: LspEditorIRangeWire;
}

interface LspEditorTextEditWire {
  range: LspEditorIRangeWire;
  newText: string;
}

interface LspEditorCompletionItemWire {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string; isTrusted?: boolean };
  filterText?: string;
  sortText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspEditorTextEditWire;
  additionalTextEdits?: LspEditorTextEditWire[];
}

interface LspSemanticTokensLegendWire {
  tokenTypes: string[];
  tokenModifiers: string[];
  supported: boolean;
}

interface LspSemanticTokensFullWire {
  legend: { tokenTypes: string[]; tokenModifiers: string[] };
  data: number[];
  resultId: string | null;
}

async function postLspEditorJson<T>(
  pathSuffix: string,
  sessionId: string,
  relativePath: string,
  jsonBody: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const rel = relativePath.replace(/\\/g, '/');
  if (!sessionId.trim() || !rel) {
    return { ok: false, error: 'Missing session or path.' };
  }
  try {
    const params = new URLSearchParams({ session_id: sessionId.trim() });
    const res = await pythonControlFetch(`${pathSuffix}?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonBody),
    });
    if (!res.ok) {
      const detail = (await res.text()).trim() || `HTTP ${res.status}`;
      return { ok: false, error: detail };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export function registerLspStatusIpc(): void {
  ipcMain.handle(
    'get-lsp-dashboard-status',
    async (_event, sessionId: unknown): Promise<
      | { ok: true; status: LspDashboardStatus }
      | { ok: false; error: string }
    > => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!sid) {
        return { ok: false, error: 'No conversation session.' };
      }
      try {
        const res = await pythonControlFetch(`/lsp/status?session_id=${encodeURIComponent(sid)}`);
        if (!res.ok) {
          const detail = (await res.text()).trim() || `HTTP ${res.status}`;
          return { ok: false, error: detail };
        }
        const status = (await res.json()) as LspDashboardStatus;
        return { ok: true, status };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  );

  /**
   * Sync on-disk file into LSP (didOpen) — starts the language-server subprocess if needed.
   * Matches ``GET /lsp/diagnostics`` with ``refresh_active_document=true``.
   */
  ipcMain.handle(
    'warm-lsp-for-active-file',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      encoding?: unknown,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      if (!sid || !rel) {
        return { ok: false, error: 'Missing session or path.' };
      }
      const enc = typeof encoding === 'string' && encoding.trim() ? encoding.trim() : 'utf-8';
      try {
        const params = new URLSearchParams({
          session_id: sid,
          relative_path: rel,
          refresh_active_document: 'true',
          encoding: enc,
        });
        const res = await pythonControlFetch(`/lsp/diagnostics?${params.toString()}`);
        if (!res.ok) {
          const detail = (await res.text()).trim() || `HTTP ${res.status}`;
          return { ok: false, error: detail };
        }
        await res.json();
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'warm-lsp-server',
    async (
      _event,
      sessionId: unknown,
      server: unknown,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const srv = typeof server === 'string' ? server.trim().toLowerCase() : '';
      if (!sid || !isSemanticLegendServerId(srv)) {
        return { ok: false, error: 'Missing session or invalid LSP server id.' };
      }
      try {
        const params = new URLSearchParams({ session_id: sid, server: srv });
        const res = await pythonControlFetch(`/lsp/warm-server?${params.toString()}`, { method: 'POST' });
        if (!res.ok) {
          const detail = (await res.text()).trim() || `HTTP ${res.status}`;
          return { ok: false, error: detail };
        }
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  );

  /** Monaco workspace hover → ``POST /lsp/hover`` (syncs buffer + ``textDocument/hover``). */
  ipcMain.handle(
    'lsp-editor-hover',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; markdown: string | null; range?: LspEditorIRangeWire | null } | { ok: false; error: string }> => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      const ln = typeof line === 'number' && Number.isFinite(line) ? Math.floor(line) : NaN;
      const col = typeof character === 'number' && Number.isFinite(character) ? Math.floor(character) : NaN;
      const skipSync = skipDocumentSync === true;
      if (!sid || !rel || ln < 1 || col < 1) {
        return { ok: false, error: 'Missing session, path, or position.' };
      }
      try {
        const params = new URLSearchParams({ session_id: sid });
        const jsonBody: Record<string, unknown> = {
          relative_path: rel,
          line: ln,
          character: col,
          skip_document_sync: skipSync,
        };
        if (!skipSync) {
          jsonBody.document_text = typeof documentText === 'string' ? documentText : null;
        }
        const res = await pythonControlFetch(`/lsp/hover?${params.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(jsonBody),
        });
        if (!res.ok) {
          const detail = (await res.text()).trim() || `HTTP ${res.status}`;
          return { ok: false, error: detail };
        }
        const body = (await res.json()) as { markdown?: string | null; range?: LspEditorIRangeWire | null };
        const md = body.markdown;
        return {
          ok: true,
          markdown: md === undefined || md === null ? null : String(md),
          range: body.range ?? null,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'lsp-editor-definition',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<
      | { ok: true; locations: LspEditorLocationWire[] }
      | { ok: false; error: string }
    > => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      const ln = typeof line === 'number' && Number.isFinite(line) ? Math.floor(line) : NaN;
      const col = typeof character === 'number' && Number.isFinite(character) ? Math.floor(character) : NaN;
      const skipSync = skipDocumentSync === true;
      if (!sid || !rel || ln < 1 || col < 1) {
        return { ok: false, error: 'Missing session, path, or position.' };
      }
      const jsonBody: Record<string, unknown> = {
        relative_path: rel,
        line: ln,
        character: col,
        skip_document_sync: skipSync,
      };
      if (!skipSync) {
        jsonBody.document_text = typeof documentText === 'string' ? documentText : null;
      }
      const out = await postLspEditorJson<{ locations: LspEditorLocationWire[] }>('/lsp/definition', sid, rel, jsonBody);
      if (!out.ok) {
        return out;
      }
      return { ok: true, locations: out.data.locations ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-references',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      documentText: unknown,
      includeDeclaration: unknown,
      skipDocumentSync: unknown,
    ): Promise<
      | { ok: true; locations: LspEditorLocationWire[] }
      | { ok: false; error: string }
    > => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      const ln = typeof line === 'number' && Number.isFinite(line) ? Math.floor(line) : NaN;
      const col = typeof character === 'number' && Number.isFinite(character) ? Math.floor(character) : NaN;
      const skipSync = skipDocumentSync === true;
      const incDecl = includeDeclaration === true;
      if (!sid || !rel || ln < 1 || col < 1) {
        return { ok: false, error: 'Missing session, path, or position.' };
      }
      const jsonBody: Record<string, unknown> = {
        relative_path: rel,
        line: ln,
        character: col,
        include_declaration: incDecl,
        skip_document_sync: skipSync,
      };
      if (!skipSync) {
        jsonBody.document_text = typeof documentText === 'string' ? documentText : null;
      }
      const out = await postLspEditorJson<{ locations: LspEditorLocationWire[] }>('/lsp/references', sid, rel, jsonBody);
      if (!out.ok) {
        return out;
      }
      return { ok: true, locations: out.data.locations ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-document-symbols',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<
      | {
          ok: true;
          hierarchical: LspEditorDocumentSymbolWire[];
          flat: LspEditorFlatSymbolWire[];
        }
      | { ok: false; error: string }
    > => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      const skipSync = skipDocumentSync === true;
      if (!sid || !rel) {
        return { ok: false, error: 'Missing session or path.' };
      }
      const jsonBody: Record<string, unknown> = {
        relative_path: rel,
        skip_document_sync: skipSync,
      };
      if (!skipSync) {
        jsonBody.document_text = typeof documentText === 'string' ? documentText : null;
      }
      const out = await postLspEditorJson<{
        hierarchical: LspEditorDocumentSymbolWire[];
        flat: LspEditorFlatSymbolWire[];
      }>('/lsp/document-symbols', sid, rel, jsonBody);
      if (!out.ok) {
        return out;
      }
      return {
        ok: true,
        hierarchical: out.data.hierarchical ?? [],
        flat: out.data.flat ?? [],
      };
    },
  );

  ipcMain.handle(
    'lsp-editor-completion',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      documentText: unknown,
      triggerKind: unknown,
      triggerCharacter: unknown,
      skipDocumentSync: unknown,
    ): Promise<
      | { ok: true; isIncomplete: boolean; items: LspEditorCompletionItemWire[] }
      | { ok: false; error: string }
    > => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      const ln = typeof line === 'number' && Number.isFinite(line) ? Math.floor(line) : NaN;
      const col = typeof character === 'number' && Number.isFinite(character) ? Math.floor(character) : NaN;
      const skipSync = skipDocumentSync === true;
      const tk =
        typeof triggerKind === 'number' && Number.isFinite(triggerKind)
          ? Math.max(1, Math.min(3, Math.floor(triggerKind)))
          : 1;
      const tc =
        typeof triggerCharacter === 'string' && triggerCharacter.length > 0 ? triggerCharacter : null;
      if (!sid || !rel || ln < 1 || col < 1) {
        return { ok: false, error: 'Missing session, path, or position.' };
      }
      const jsonBody: Record<string, unknown> = {
        relative_path: rel,
        line: ln,
        character: col,
        trigger_kind: tk,
        trigger_character: tc,
        skip_document_sync: skipSync,
      };
      if (!skipSync) {
        jsonBody.document_text = typeof documentText === 'string' ? documentText : null;
      }
      const out = await postLspEditorJson<{
        isIncomplete?: boolean;
        items: LspEditorCompletionItemWire[];
      }>('/lsp/completion', sid, rel, jsonBody);
      if (!out.ok) {
        return out;
      }
      return {
        ok: true,
        isIncomplete: !!out.data.isIncomplete,
        items: out.data.items ?? [],
      };
    },
  );

  ipcMain.handle(
    'lsp-editor-rename',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      documentText: unknown,
      newName: unknown,
      skipDocumentSync: unknown,
    ): Promise<
      | {
          ok: true;
          workspaceEdit: { changes: Record<string, LspEditorTextEditWire[]> } | null;
        }
      | { ok: false; error: string }
    > => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      const ln = typeof line === 'number' && Number.isFinite(line) ? Math.floor(line) : NaN;
      const col = typeof character === 'number' && Number.isFinite(character) ? Math.floor(character) : NaN;
      const skipSync = skipDocumentSync === true;
      const name = typeof newName === 'string' ? newName : '';
      if (!sid || !rel || ln < 1 || col < 1 || !name.trim()) {
        return { ok: false, error: 'Missing session, path, position, or new name.' };
      }
      const jsonBody: Record<string, unknown> = {
        relative_path: rel,
        line: ln,
        character: col,
        new_name: name,
        skip_document_sync: skipSync,
      };
      if (!skipSync) {
        jsonBody.document_text = typeof documentText === 'string' ? documentText : null;
      }
      const out = await postLspEditorJson<{ workspaceEdit: { changes: Record<string, LspEditorTextEditWire[]> } | null }>(
        '/lsp/rename',
        sid,
        rel,
        jsonBody,
      );
      if (!out.ok) {
        return out;
      }
      return { ok: true, workspaceEdit: out.data.workspaceEdit ?? null };
    },
  );

  ipcMain.handle(
    'lsp-editor-semantic-tokens-legend',
    async (
      _event,
      sessionId: unknown,
      server: unknown,
    ): Promise<{ ok: true; legend: LspSemanticTokensLegendWire } | { ok: false; error: string }> => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const srv = typeof server === 'string' ? server.trim().toLowerCase() : '';
      if (!sid || !isSemanticLegendServerId(srv)) {
        return { ok: false, error: 'Missing session or invalid LSP server id for semantic legend.' };
      }
      try {
        const params = new URLSearchParams({
          session_id: sid,
          server: srv,
        });
        const res = await pythonControlFetch(`/lsp/semantic-tokens-legend?${params.toString()}`);
        if (!res.ok) {
          const detail = (await res.text()).trim() || `HTTP ${res.status}`;
          return { ok: false, error: detail };
        }
        const data = (await res.json()) as LspSemanticTokensLegendWire;
        return {
          ok: true,
          legend: {
            tokenTypes: data.tokenTypes ?? [],
            tokenModifiers: data.tokenModifiers ?? [],
            supported: !!data.supported,
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'lsp-editor-semantic-tokens-full',
    async (
      _event,
      sessionId: unknown,
      relativePath: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; payload: LspSemanticTokensFullWire } | { ok: false; error: string }> => {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
      const rel = raw.replace(/\\/g, '/');
      const skipSync = skipDocumentSync === true;
      if (!sid || !rel) {
        return { ok: false, error: 'Missing session or path.' };
      }
      const jsonBody: Record<string, unknown> = {
        relative_path: rel,
        skip_document_sync: skipSync,
      };
      if (!skipSync) {
        jsonBody.document_text = typeof documentText === 'string' ? documentText : null;
      }
      const out = await postLspEditorJson<LspSemanticTokensFullWire>('/lsp/semantic-tokens/full', sid, rel, jsonBody);
      if (!out.ok) {
        return out;
      }
      const d = out.data;
      return {
        ok: true,
        payload: {
          legend: {
            tokenTypes: d.legend?.tokenTypes ?? [],
            tokenModifiers: d.legend?.tokenModifiers ?? [],
          },
          data: d.data ?? [],
          resultId: d.resultId === undefined || d.resultId === null ? null : String(d.resultId),
        },
      };
    },
  );
}
