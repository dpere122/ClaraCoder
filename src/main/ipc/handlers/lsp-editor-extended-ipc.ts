import { ipcMain } from 'electron';
import { assertTrustedMainRendererOrThrow } from '../assert-trusted-renderer';
import type {
  LspEditorCodeActionIpc,
  LspEditorCodeLensIpc,
  LspEditorCompletionItemIpc,
  LspEditorDiagnosticIpc,
  LspEditorDocumentHighlightIpc,
  LspEditorInlayHintIpc,
  LspEditorSignatureHelpIpc,
  LspEditorTextEditIpc,
} from '../../../preload/lsp-types';
import { pythonControlFetch, pythonLspFetch } from '../../python/http-client';

async function postLspEditorJson<T>(
  pathSuffix: string,
  sessionId: string,
  jsonBody: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const sid = sessionId.trim();
  if (!sid) {
    return { ok: false, error: 'Missing session.' };
  }
  try {
    const params = new URLSearchParams({ session_id: sid });
    const res = await pythonLspFetch(`${pathSuffix}?${params.toString()}`, {
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

function docSyncBody(
  rel: string,
  documentText: unknown,
  skipDocumentSync: unknown,
): Record<string, unknown> {
  const skipSync = skipDocumentSync === true;
  const body: Record<string, unknown> = {
    relative_path: rel,
    skip_document_sync: skipSync,
  };
  if (!skipSync) {
    body.document_text = typeof documentText === 'string' ? documentText : null;
  }
  return body;
}

export function registerLspEditorExtendedIpc(): void {
  ipcMain.handle(
    'lsp-editor-diagnostics',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<
      | { ok: true; diagnostics: LspEditorDiagnosticIpc[]; generation: number }
      | { ok: false; error: string }
    > => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      if (!sid || !rel) {
        return { ok: false, error: 'Missing session or path.' };
      }
      const out = await postLspEditorJson<{ diagnostics: LspEditorDiagnosticIpc[]; generation: number }>(
        '/lsp/editor/diagnostics',
        sid,
        docSyncBody(rel, documentText, skipDocumentSync),
      );
      if (!out.ok) {
        return out;
      }
      return {
        ok: true,
        diagnostics: out.data.diagnostics ?? [],
        generation: out.data.generation ?? 0,
      };
    },
  );

  ipcMain.handle(
    'lsp-diagnostics-generation',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
    ): Promise<{ ok: true; generation: number; count: number } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      if (!sid || !rel) {
        return { ok: false, error: 'Missing session or path.' };
      }
      try {
        const params = new URLSearchParams({ session_id: sid, relative_path: rel });
        const res = await pythonControlFetch(`/lsp/diagnostics-generation?${params.toString()}`);
        if (!res.ok) {
          const detail = (await res.text()).trim() || `HTTP ${res.status}`;
          return { ok: false, error: detail };
        }
        const data = (await res.json()) as { generation?: number; count?: number };
        return { ok: true, generation: data.generation ?? 0, count: data.count ?? 0 };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'lsp-editor-signature-help',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      documentText: unknown,
      triggerCharacter: unknown,
      isRetrigger: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; signatureHelp: LspEditorSignatureHelpIpc | null } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      const ln = typeof line === 'number' && Number.isFinite(line) ? Math.floor(line) : NaN;
      const col = typeof character === 'number' && Number.isFinite(character) ? Math.floor(character) : NaN;
      if (!sid || !rel || ln < 1 || col < 1) {
        return { ok: false, error: 'Missing session, path, or position.' };
      }
      const body = {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        line: ln,
        character: col,
        trigger_character:
          typeof triggerCharacter === 'string' && triggerCharacter.length > 0 ? triggerCharacter : null,
        is_retrigger: isRetrigger === true,
      };
      const out = await postLspEditorJson<{ signatureHelp: LspEditorSignatureHelpIpc | null }>(
        '/lsp/signature-help',
        sid,
        body,
      );
      if (!out.ok) {
        return out;
      }
      return { ok: true, signatureHelp: out.data.signatureHelp ?? null };
    },
  );

  ipcMain.handle(
    'lsp-editor-document-highlight',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; highlights: LspEditorDocumentHighlightIpc[] } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      const ln = typeof line === 'number' && Number.isFinite(line) ? Math.floor(line) : NaN;
      const col = typeof character === 'number' && Number.isFinite(character) ? Math.floor(character) : NaN;
      if (!sid || !rel || ln < 1 || col < 1) {
        return { ok: false, error: 'Missing session, path, or position.' };
      }
      const out = await postLspEditorJson<{ highlights: LspEditorDocumentHighlightIpc[] }>('/lsp/document-highlight', sid, {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        line: ln,
        character: col,
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, highlights: out.data.highlights ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-completion-resolve',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      item: unknown,
    ): Promise<{ ok: true; item: LspEditorCompletionItemIpc } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      if (!sid || !rel || !item || typeof item !== 'object') {
        return { ok: false, error: 'Missing session, path, or item.' };
      }
      const out = await postLspEditorJson<{ items: LspEditorCompletionItemIpc[] }>('/lsp/completion-resolve', sid, {
        relative_path: rel,
        item,
      });
      if (!out.ok) {
        return out;
      }
      const resolved = out.data.items?.[0];
      if (!resolved) {
        return { ok: false, error: 'Completion resolve returned no item.' };
      }
      return { ok: true, item: resolved };
    },
  );

  ipcMain.handle(
    'lsp-editor-code-action',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      startLine: unknown,
      startCharacter: unknown,
      endLine: unknown,
      endCharacter: unknown,
      documentText: unknown,
      diagnostics: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; actions: LspEditorCodeActionIpc[] } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      const sl = typeof startLine === 'number' ? Math.floor(startLine) : NaN;
      const sc = typeof startCharacter === 'number' ? Math.floor(startCharacter) : NaN;
      const el = typeof endLine === 'number' ? Math.floor(endLine) : NaN;
      const ec = typeof endCharacter === 'number' ? Math.floor(endCharacter) : NaN;
      if (!sid || !rel || sl < 1 || sc < 1 || el < 1 || ec < 1) {
        return { ok: false, error: 'Missing session, path, or range.' };
      }
      const out = await postLspEditorJson<{ actions: LspEditorCodeActionIpc[] }>('/lsp/code-action', sid, {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        start_line: sl,
        start_character: sc,
        end_line: el,
        end_character: ec,
        diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, actions: out.data.actions ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-formatting',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      documentText: unknown,
      tabSize: unknown,
      insertSpaces: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; edits: LspEditorTextEditIpc[] } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      if (!sid || !rel) {
        return { ok: false, error: 'Missing session or path.' };
      }
      const out = await postLspEditorJson<{ edits: LspEditorTextEditIpc[] }>('/lsp/formatting', sid, {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        tab_size: typeof tabSize === 'number' ? tabSize : 4,
        insert_spaces: insertSpaces !== false,
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, edits: out.data.edits ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-range-formatting',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      startLine: unknown,
      startCharacter: unknown,
      endLine: unknown,
      endCharacter: unknown,
      documentText: unknown,
      tabSize: unknown,
      insertSpaces: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; edits: LspEditorTextEditIpc[] } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      const sl = typeof startLine === 'number' ? Math.floor(startLine) : NaN;
      const sc = typeof startCharacter === 'number' ? Math.floor(startCharacter) : NaN;
      const el = typeof endLine === 'number' ? Math.floor(endLine) : NaN;
      const ec = typeof endCharacter === 'number' ? Math.floor(endCharacter) : NaN;
      if (!sid || !rel || sl < 1 || sc < 1 || el < 1 || ec < 1) {
        return { ok: false, error: 'Missing session, path, or range.' };
      }
      const out = await postLspEditorJson<{ edits: LspEditorTextEditIpc[] }>('/lsp/range-formatting', sid, {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        start_line: sl,
        start_character: sc,
        end_line: el,
        end_character: ec,
        tab_size: typeof tabSize === 'number' ? tabSize : 4,
        insert_spaces: insertSpaces !== false,
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, edits: out.data.edits ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-on-type-formatting',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      line: unknown,
      character: unknown,
      ch: unknown,
      documentText: unknown,
      tabSize: unknown,
      insertSpaces: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; edits: LspEditorTextEditIpc[] } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      const ln = typeof line === 'number' ? Math.floor(line) : NaN;
      const col = typeof character === 'number' ? Math.floor(character) : NaN;
      const characterTyped = typeof ch === 'string' && ch.length === 1 ? ch : '';
      if (!sid || !rel || ln < 1 || col < 1 || !characterTyped) {
        return { ok: false, error: 'Missing session, path, position, or character.' };
      }
      const out = await postLspEditorJson<{ edits: LspEditorTextEditIpc[] }>('/lsp/on-type-formatting', sid, {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        line: ln,
        character: col,
        ch: characterTyped,
        tab_size: typeof tabSize === 'number' ? tabSize : 4,
        insert_spaces: insertSpaces !== false,
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, edits: out.data.edits ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-inlay-hints',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      startLine: unknown,
      startCharacter: unknown,
      endLine: unknown,
      endCharacter: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; hints: LspEditorInlayHintIpc[] } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      const sl = typeof startLine === 'number' ? Math.floor(startLine) : NaN;
      const sc = typeof startCharacter === 'number' ? Math.floor(startCharacter) : NaN;
      const el = typeof endLine === 'number' ? Math.floor(endLine) : NaN;
      const ec = typeof endCharacter === 'number' ? Math.floor(endCharacter) : NaN;
      if (!sid || !rel || sl < 1 || sc < 1 || el < 1 || ec < 1) {
        return { ok: false, error: 'Missing session, path, or range.' };
      }
      const out = await postLspEditorJson<{ hints: LspEditorInlayHintIpc[] }>('/lsp/inlay-hints', sid, {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        start_line: sl,
        start_character: sc,
        end_line: el,
        end_character: ec,
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, hints: out.data.hints ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-code-lens',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<{ ok: true; lenses: LspEditorCodeLensIpc[] } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      if (!sid || !rel) {
        return { ok: false, error: 'Missing session or path.' };
      }
      const out = await postLspEditorJson<{ lenses: LspEditorCodeLensIpc[] }>('/lsp/code-lens', sid, docSyncBody(rel, documentText, skipDocumentSync));
      if (!out.ok) {
        return out;
      }
      return { ok: true, lenses: out.data.lenses ?? [] };
    },
  );

  ipcMain.handle(
    'lsp-editor-code-lens-resolve',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      lens: unknown,
    ): Promise<{ ok: true; lens: LspEditorCodeLensIpc | null } | { ok: false; error: string }> => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      if (!sid || !rel || !lens || typeof lens !== 'object') {
        return { ok: false, error: 'Missing session, path, or lens.' };
      }
      const out = await postLspEditorJson<{ lens: LspEditorCodeLensIpc | null }>('/lsp/code-lens/resolve', sid, {
        relative_path: rel,
        lens,
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, lens: out.data.lens ?? null };
    },
  );

  ipcMain.handle(
    'lsp-editor-semantic-tokens-delta',
    async (
      event,
      sessionId: unknown,
      relativePath: unknown,
      previousResultId: unknown,
      documentText: unknown,
      skipDocumentSync: unknown,
    ): Promise<
      | { ok: true; payload: { legend: { tokenTypes: string[]; tokenModifiers: string[] }; resultId: string | null; edits: unknown[] } }
      | { ok: false; error: string }
    > => {
      try {
        assertTrustedMainRendererOrThrow(event);
      } catch {
        return { ok: false, error: 'Untrusted IPC sender' };
      }
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      const rel = typeof relativePath === 'string' ? relativePath.trim().replace(/\\/g, '/') : '';
      const prev = typeof previousResultId === 'string' ? previousResultId.trim() : '';
      if (!sid || !rel || !prev) {
        return { ok: false, error: 'Missing session, path, or previous result id.' };
      }
      const out = await postLspEditorJson<{
        legend: { tokenTypes: string[]; tokenModifiers: string[] };
        resultId: string | null;
        edits: unknown[];
      }>('/lsp/semantic-tokens/full/delta', sid, {
        ...docSyncBody(rel, documentText, skipDocumentSync),
        previous_result_id: prev,
      });
      if (!out.ok) {
        return out;
      }
      return { ok: true, payload: out.data };
    },
  );
}
