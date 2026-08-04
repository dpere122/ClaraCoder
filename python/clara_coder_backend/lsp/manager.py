"""Session-scoped LSP managers and diagnostics cache (pluggable server backends)."""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.client import JsonRpcLspClient
from clara_coder_backend.lsp.diagnostics import normalize_lsp_diagnostics
from clara_coder_backend.lsp.file_policy import get_lsp_file_policy, lsp_server_for_path, normalize_relative_posix_path
from clara_coder_backend.lsp.jedi_init_options import jedi_environment_path_for_workspace
from clara_coder_backend.lsp.registry import (
    LspServerKind,
    get_lsp_server_plugin,
    iter_registered_lsp_server_ids,
)
from clara_coder_backend.lsp.server_plugin import LspServerPlugin
from clara_coder_backend.lsp.overlay_hooks import clear_lsp_staging_overlay, ensure_lsp_staging_overlay
from clara_coder_backend.session.state import current_session_id, get_session
from clara_coder_backend.workspace.paths import normalize_relative_path
from clara_coder_backend.workspace.workspace_text_io import read_file_for_tools, validate_workspace_encoding

logger = logging.getLogger('clara.lsp.manager')

__all__ = [
    'PythonLspManager',
    'SessionWorkspaceLspManager',
    'activate_session_lsp_scope',
    'diagnostics_cache_for_scope',
    'get_session_lsp_manager',
    'get_lsp_dashboard_status',
    'count_active_lsp_sessions',
    'shutdown_session_lsp',
    'shutdown_session_lsp_server',
    'shutdown_session_python_lsp',
    'shutdown_all_lsp_managers',
    'list_session_diagnostics',
    'sync_session_document',
    'close_session_document',
    'LspServerKind',
]

_MANAGERS_LOCK = threading.RLock()
# Keyed by (session_id, server_id, scope) so workspace + staging managers can coexist.
_SESSION_MANAGERS: dict[tuple[str, str, str], SessionWorkspaceLspManager] = {}
_VALID_LSP_SCOPES = frozenset({'workspace', 'staging'})


def _normalize_lsp_scope(scope: str | None) -> str:
    value = (scope or '').strip().lower() or 'workspace'
    if value not in _VALID_LSP_SCOPES:
        raise ValueError(f'Unsupported LSP scope: {scope!r}')
    return value


def diagnostics_cache_for_scope(session: SessionState, scope: str | None = None) -> dict[str, list[dict[str, object]]]:
    """Return the mutable diagnostics cache for one LSP scope (creates the bucket if missing)."""

    desired = _normalize_lsp_scope(scope or getattr(session.lsp, 'lsp_active_scope', None))
    caches = session.lsp.lsp_diagnostics_by_scope
    bucket = caches.get(desired)
    if bucket is None:
        bucket = {}
        caches[desired] = bucket
    return bucket


def clear_diagnostics_caches(session: SessionState, *, scope: str | None = None) -> None:
    """Clear one scope cache, or both when ``scope`` is omitted."""

    if scope is None:
        session.lsp.lsp_diagnostics_by_scope = {'workspace': {}, 'staging': {}}
        return
    diagnostics_cache_for_scope(session, scope).clear()


def _should_retry_lsp_bootstrap(exc: Exception) -> bool:
    text = str(exc).lower()
    return 'lsp client closed' in text or 'initialize' in text


def _path_to_uri(path: Path) -> str:
    return path.resolve().as_uri()


def _uri_to_path(uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme != 'file':
        raise ValueError(f'Unsupported document URI: {uri}')
    raw_path = unquote(parsed.path)
    if os.name == 'nt' and raw_path.startswith('/'):
        raw_path = raw_path[1:]
    return Path(raw_path).resolve()


def _workspace_capabilities() -> dict[str, Any]:
    return {
        'textDocument': {
            'hover': {'contentFormat': ['markdown', 'plaintext']},
            'definition': {'linkSupport': True},
            'references': {},
            'completion': {
                'dynamicRegistration': False,
                'completionItem': {
                    'snippetSupport': True,
                    'documentationFormat': ['markdown', 'plaintext'],
                },
            },
            'rename': {'dynamicRegistration': False, 'prepareSupport': False},
            'documentSymbol': {
                'hierarchicalDocumentSymbolSupport': True,
                'symbolKind': {'valueSet': list(range(1, 27))},
            },
            'semanticTokens': {
                'dynamicRegistration': False,
                'requests': {
                    'range': False,
                    'full': {'delta': False},
                },
                'tokenTypes': [],
                'tokenModifiers': [],
                'formats': ['relative'],
                'overlappingTokenSupport': False,
                'multilineTokenSupport': True,
                'serverCancelSupport': False,
            },
            'publishDiagnostics': {'relatedInformation': True},
            'signatureHelp': {
                'dynamicRegistration': False,
                'signatureInformation': {
                    'documentationFormat': ['markdown', 'plaintext'],
                    'parameterInformation': {'labelOffsetSupport': True},
                },
            },
            'documentHighlight': {'dynamicRegistration': False},
            'codeAction': {
                'dynamicRegistration': False,
                'codeActionLiteralSupport': {
                    'codeActionKind': {
                        'valueSet': [
                            'quickfix',
                            'refactor',
                            'refactor.extract',
                            'refactor.inline',
                            'refactor.rewrite',
                            'source',
                            'source.organizeImports',
                            'source.fixAll',
                        ],
                    },
                },
            },
            'formatting': {'dynamicRegistration': False},
            'rangeFormatting': {'dynamicRegistration': False},
            'onTypeFormatting': {'dynamicRegistration': False},
            'inlayHint': {
                'dynamicRegistration': False,
                'resolveSupport': {'properties': ['tooltip', 'textEdits', 'label.tooltip']},
            },
            'codeLens': {'dynamicRegistration': False, 'resolveProvider': True},
            'synchronization': {'didSave': True, 'dynamicRegistration': False},
        },
        'workspace': {
            'workspaceFolders': True,
            'didChangeWatchedFiles': {'dynamicRegistration': False},
            'semanticTokens': {'refreshSupport': True},
        },
    }


def _extract_semantic_tokens_legend(init_result: Any) -> dict[str, list[str]] | None:
    """Parse ``capabilities.semanticTokensProvider.legend`` from ``initialize`` result."""

    if not isinstance(init_result, dict):
        return None
    caps = init_result.get('capabilities')
    if not isinstance(caps, dict):
        return None
    stp = caps.get('semanticTokensProvider')
    if not isinstance(stp, dict):
        return None
    legend = stp.get('legend')
    if not isinstance(legend, dict):
        return None
    tt = legend.get('tokenTypes')
    tm = legend.get('tokenModifiers')
    if not isinstance(tt, list) or not isinstance(tm, list):
        return None
    return {
        'tokenTypes': [str(x) for x in tt],
        'tokenModifiers': [str(x) for x in tm],
    }


class SessionWorkspaceLspManager:
    """Owns one language-server subprocess for a session/workspace/scope/server tuple."""

    def __init__(
        self,
        *,
        session_id: str,
        session: SessionState,
        workspace_root: Path,
        scope: str,
        server_kind: str,
        client_factory: Any | None = None,
    ) -> None:
        self.session_id = session_id
        self.session = session
        self.workspace_root = Path(workspace_root).resolve()
        self.scope = _normalize_lsp_scope(scope)
        self.server_kind = (server_kind or '').strip()
        self._plugin: LspServerPlugin = get_lsp_server_plugin(self.server_kind)
        self._plugin_state: Any = self._plugin.create_state()
        self._client_factory = client_factory
        self._client: JsonRpcLspClient | None = None
        self._lock = threading.RLock()
        self._diag_cond = threading.Condition(self._lock)
        self._doc_versions: dict[str, int] = {}
        self._diag_generation: dict[str, int] = {}
        self._last_synced_digest: dict[str, bytes] = {}
        self._semantic_tokens_legend: dict[str, list[str]] | None = None

    def should_defer_semantic_tokens_legend_without_document_seed(self) -> bool:
        """True when legend prefetch must not spawn this server before any document seed."""

        return self._plugin.should_defer_semantic_tokens_legend_without_document_seed(self._plugin_state)

    def should_skip_typescript_cold_start_without_seed(self) -> bool:
        """Backward-compatible alias for routes/tests."""

        return self.should_defer_semantic_tokens_legend_without_document_seed()

    def ensure_started(self) -> None:
        with self._lock:
            if self._client is not None:
                return
            bundle = self._plugin.compute_start_params(
                session=self.session,
                workspace_root=self.workspace_root,
                state=self._plugin_state,
            )
            lsp_cwd = bundle.lsp_cwd
            command = bundle.command
            init_opts = dict(bundle.init_options or {})
            factory = self._client_factory or (
                lambda *, command, workspace_root, notification_handler: JsonRpcLspClient(
                    command,
                    workspace_root=workspace_root,
                    notification_handler=notification_handler,
                )
            )
            client = factory(
                command=command,
                workspace_root=lsp_cwd,
                notification_handler=self._handle_notification,
            )
            init_result = client.initialize(
                root_uri=_path_to_uri(lsp_cwd),
                process_id=os.getpid(),
                capabilities=_workspace_capabilities(),
                initialization_options=init_opts,
            )
            self._semantic_tokens_legend = _extract_semantic_tokens_legend(init_result)
            self._client = client
            self._plugin.on_after_client_started(
                session=self.session,
                workspace_root=self.workspace_root,
                state=self._plugin_state,
                lsp_cwd=lsp_cwd,
            )
            self.session.lsp.lsp_workspace_root = str(self.workspace_root)
            logger.info(
                '%s LSP session ready session=%s scope=%s workspace=%s lsp_cwd=%s',
                self.server_kind,
                self.session_id,
                self.scope,
                self.workspace_root,
                lsp_cwd,
            )

    def _diag_cache(self) -> dict[str, list[dict[str, object]]]:
        return diagnostics_cache_for_scope(self.session, self.scope)

    def shutdown(self) -> None:
        with self._lock:
            client = self._client
            self._client = None
            self._semantic_tokens_legend = None
            tracked = list(self._doc_versions.keys())
            self._doc_versions.clear()
            self._diag_generation.clear()
            self._last_synced_digest.clear()
            cache = self._diag_cache()
            for rel in tracked:
                cache.pop(rel, None)
        if client is not None:
            try:
                client.shutdown()
            except Exception as exc:
                logger.warning(
                    '%s LSP shutdown failed session=%s scope=%s err=%s',
                    self.server_kind,
                    self.session_id,
                    self.scope,
                    exc,
                )
        self._plugin.after_shutdown(self.session, self._plugin_state)
        my_key = (self.session_id, self.server_kind, self.scope)
        with _MANAGERS_LOCK:
            any_remaining = any(
                k != my_key and k[0] == self.session_id for k in _SESSION_MANAGERS
            )
        if not any_remaining:
            self.session.lsp.lsp_workspace_root = ''
            if self.session.lsp.lsp_active_scope == self.scope:
                self.session.lsp.lsp_active_scope = 'workspace'

    def sync_document(
        self,
        relative_path: str,
        text: str,
        *,
        wait_for_diagnostics: bool = True,
    ) -> list[dict[str, Any]]:
        rel = normalize_relative_posix_path(relative_path)
        policy = self._policy(rel)
        if policy is None:
            raise ValueError(f'LSP sync is not supported for `{rel}` on {self.server_kind} server.')
        digest = hashlib.sha256(text.encode('utf-8')).digest()
        with self._lock:
            running = self._client is not None
        if self._plugin.on_before_sync_document(
            session=self.session,
            workspace_root=self.workspace_root,
            relative_posix_path=rel,
            state=self._plugin_state,
            client_running=running,
        ):
            self.shutdown()
        self.ensure_started()
        path = normalize_relative_path(self.workspace_root, rel)
        uri = _path_to_uri(path)
        with self._lock:
            cache = self._diag_cache()
            if rel in self._doc_versions and self._last_synced_digest.get(rel) == digest:
                return list(cache.get(rel, []))
            prev_generation = self._diag_generation.get(rel, 0)
            version = self._doc_versions.get(rel, 0) + 1
            self._doc_versions[rel] = version
            client = self._require_client()
            if version == 1:
                client.notify(
                    'textDocument/didOpen',
                    {
                        'textDocument': {
                            'uri': uri,
                            'languageId': policy.language_id,
                            'version': version,
                            'text': text,
                        }
                    },
                )
                logger.info(
                    '%s LSP didOpen session=%s scope=%s path=%s version=%s',
                    self.server_kind,
                    self.session_id,
                    self.scope,
                    rel,
                    version,
                )
            else:
                client.notify(
                    'textDocument/didChange',
                    {
                        'textDocument': {'uri': uri, 'version': version},
                        'contentChanges': [{'text': text}],
                    },
                )
                logger.info(
                    '%s LSP didChange session=%s scope=%s path=%s version=%s',
                    self.server_kind,
                    self.session_id,
                    self.scope,
                    rel,
                    version,
                )
            self._last_synced_digest[rel] = digest
            if wait_for_diagnostics:
                self._wait_for_diagnostics(rel, prev_generation)
            return list(cache.get(rel, []))

    def sync_workspace_document(
        self,
        relative_path: str,
        *,
        encoding: str = 'utf-8',
        wait_for_diagnostics: bool = True,
    ) -> list[dict[str, Any]]:
        rel = normalize_relative_posix_path(relative_path)
        enc = validate_workspace_encoding(encoding)
        target = normalize_relative_path(self.workspace_root, rel)
        text = read_file_for_tools(target, enc)
        return self.sync_document(rel, text, wait_for_diagnostics=wait_for_diagnostics)

    def close_document(self, relative_path: str) -> None:
        rel = normalize_relative_posix_path(relative_path)
        if self._policy(rel) is None:
            return
        with self._lock:
            cache = self._diag_cache()
            client = self._client
            if client is None or rel not in self._doc_versions:
                cache.pop(rel, None)
                return
            target = normalize_relative_path(self.workspace_root, rel)
            client.notify('textDocument/didClose', {'textDocument': {'uri': _path_to_uri(target)}})
            self._doc_versions.pop(rel, None)
            self._last_synced_digest.pop(rel, None)
            cache.pop(rel, None)
            self._diag_generation.pop(rel, None)
            logger.info(
                '%s LSP didClose session=%s scope=%s path=%s',
                self.server_kind,
                self.session_id,
                self.scope,
                rel,
            )

    def get_diagnostics(self, relative_path: str = '') -> list[dict[str, Any]]:
        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            cache = self._diag_cache()
            if rel:
                return list(cache.get(rel, []))
            all_items: list[dict[str, Any]] = []
            for path in sorted(cache):
                all_items.extend(cache[path])
            return all_items

    def hover(self, relative_path: str, line: int, character: int) -> dict[str, Any]:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
        }
        return self._require_client().request('textDocument/hover', params, timeout_s=8.0)

    def definition(self, relative_path: str, line: int, character: int) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
        }
        return self._require_client().request('textDocument/definition', params, timeout_s=8.0)

    def references(self, relative_path: str, line: int, character: int, *, include_declaration: bool) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
            'context': {'includeDeclaration': bool(include_declaration)},
        }
        return self._require_client().request('textDocument/references', params, timeout_s=8.0)

    def document_symbols(self, relative_path: str) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))}}
        return self._require_client().request('textDocument/documentSymbol', params, timeout_s=8.0)

    def completion(
        self,
        relative_path: str,
        line: int,
        character: int,
        *,
        trigger_kind: int = 1,
        trigger_character: str | None = None,
    ) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        uri = _path_to_uri(normalize_relative_path(self.workspace_root, rel))
        ctx: dict[str, Any] = {'triggerKind': max(1, min(3, int(trigger_kind)))}
        if trigger_character is not None and trigger_character != '':
            ctx['triggerCharacter'] = trigger_character
        params = {
            'textDocument': {'uri': uri},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
            'context': ctx,
        }
        return self._require_client().request('textDocument/completion', params, timeout_s=15.0)

    def rename(self, relative_path: str, line: int, character: int, new_name: str) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        uri = _path_to_uri(normalize_relative_path(self.workspace_root, rel))
        params = {
            'textDocument': {'uri': uri},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
            'newName': str(new_name),
        }
        return self._require_client().request('textDocument/rename', params, timeout_s=25.0)

    def semantic_tokens_full(self, relative_path: str) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))}}
        return self._require_client().request('textDocument/semanticTokens/full', params, timeout_s=20.0)

    def semantic_tokens_full_delta(self, relative_path: str, previous_result_id: str) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'previousResultId': str(previous_result_id),
        }
        return self._require_client().request('textDocument/semanticTokens/full/delta', params, timeout_s=20.0)

    def get_diag_generation(self, relative_path: str) -> int:
        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            return int(self._diag_generation.get(rel, 0))

    def signature_help(
        self,
        relative_path: str,
        line: int,
        character: int,
        *,
        trigger_character: str | None = None,
        is_retrigger: bool = False,
    ) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        ctx: dict[str, Any] = {'isRetrigger': bool(is_retrigger)}
        if trigger_character:
            ctx['triggerCharacter'] = trigger_character
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
            'context': ctx,
        }
        return self._require_client().request('textDocument/signatureHelp', params, timeout_s=8.0)

    def document_highlight(self, relative_path: str, line: int, character: int) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
        }
        return self._require_client().request('textDocument/documentHighlight', params, timeout_s=8.0)

    def completion_resolve(self, item: dict[str, Any]) -> Any:
        self.ensure_started()
        return self._require_client().request('completionItem/resolve', item, timeout_s=8.0)

    def code_action(
        self,
        relative_path: str,
        start_line: int,
        start_character: int,
        end_line: int,
        end_character: int,
        diagnostics: list[dict[str, Any]],
    ) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        uri = _path_to_uri(normalize_relative_path(self.workspace_root, rel))
        lsp_diags: list[dict[str, Any]] = []
        for d in diagnostics:
            if not isinstance(d, dict):
                continue
            sl = max(0, int(d.get('line', 1)) - 1)
            sc = max(0, int(d.get('character', 1)) - 1)
            el = max(0, int(d.get('end_line', d.get('line', 1))) - 1)
            ec = max(0, int(d.get('end_character', d.get('character', 1))) - 1)
            entry: dict[str, Any] = {
                'range': {
                    'start': {'line': sl, 'character': sc},
                    'end': {'line': el, 'character': ec},
                },
                'message': str(d.get('message') or ''),
                'severity': int(d.get('severity_value') or 3),
            }
            code = d.get('code')
            if code not in (None, ''):
                entry['code'] = code
            source = d.get('source')
            if source not in (None, ''):
                entry['source'] = str(source)
            lsp_diags.append(entry)
        params = {
            'textDocument': {'uri': uri},
            'range': {
                'start': {'line': max(0, int(start_line) - 1), 'character': max(0, int(start_character) - 1)},
                'end': {'line': max(0, int(end_line) - 1), 'character': max(0, int(end_character) - 1)},
            },
            'context': {'diagnostics': lsp_diags},
        }
        return self._require_client().request('textDocument/codeAction', params, timeout_s=15.0)

    def formatting(self, relative_path: str, *, tab_size: int = 4, insert_spaces: bool = True) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'options': {'tabSize': max(1, int(tab_size)), 'insertSpaces': bool(insert_spaces)},
        }
        return self._require_client().request('textDocument/formatting', params, timeout_s=25.0)

    def range_formatting(
        self,
        relative_path: str,
        start_line: int,
        start_character: int,
        end_line: int,
        end_character: int,
        *,
        tab_size: int = 4,
        insert_spaces: bool = True,
    ) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'range': {
                'start': {'line': max(0, int(start_line) - 1), 'character': max(0, int(start_character) - 1)},
                'end': {'line': max(0, int(end_line) - 1), 'character': max(0, int(end_character) - 1)},
            },
            'options': {'tabSize': max(1, int(tab_size)), 'insertSpaces': bool(insert_spaces)},
        }
        return self._require_client().request('textDocument/rangeFormatting', params, timeout_s=25.0)

    def on_type_formatting(
        self,
        relative_path: str,
        line: int,
        character: int,
        ch: str,
        *,
        tab_size: int = 4,
        insert_spaces: bool = True,
    ) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
            'ch': str(ch),
            'options': {'tabSize': max(1, int(tab_size)), 'insertSpaces': bool(insert_spaces)},
        }
        return self._require_client().request('textDocument/onTypeFormatting', params, timeout_s=8.0)

    def inlay_hints(
        self,
        relative_path: str,
        start_line: int,
        start_character: int,
        end_line: int,
        end_character: int,
    ) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'range': {
                'start': {'line': max(0, int(start_line) - 1), 'character': max(0, int(start_character) - 1)},
                'end': {'line': max(0, int(end_line) - 1), 'character': max(0, int(end_character) - 1)},
            },
        }
        return self._require_client().request('textDocument/inlayHint', params, timeout_s=15.0)

    def code_lens(self, relative_path: str) -> Any:
        rel = self._ensure_workspace_synced(relative_path)
        params = {'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))}}
        return self._require_client().request('textDocument/codeLens', params, timeout_s=15.0)

    def code_lens_resolve(self, code_lens: dict[str, Any]) -> Any:
        self.ensure_started()
        return self._require_client().request('codeLens/resolve', code_lens, timeout_s=8.0)

    @property
    def semantic_tokens_legend(self) -> dict[str, list[str]] | None:
        return self._semantic_tokens_legend

    def _policy(self, rel: str) -> Any:
        policy = get_lsp_file_policy(rel)
        if policy is None or policy.lsp_server != self.server_kind:
            return None
        return policy

    def _ensure_workspace_synced(self, relative_path: str) -> str:
        rel = normalize_relative_posix_path(relative_path)
        if self._policy(rel) is None:
            raise ValueError(f'LSP tools do not support `{rel}` on the {self.server_kind} server.')
        if rel not in self._doc_versions:
            self.sync_workspace_document(rel)
        else:
            self.ensure_started()
        return rel

    def _handle_notification(self, method: str, params: dict[str, Any]) -> None:
        if method != 'textDocument/publishDiagnostics':
            return
        uri = str(params.get('uri') or '')
        try:
            abs_path = _uri_to_path(uri)
            rel = abs_path.resolve().relative_to(self.workspace_root.resolve()).as_posix()
        except Exception:
            logger.debug(
                'ignoring diagnostics outside workspace session=%s server=%s scope=%s uri=%s',
                self.session_id,
                self.server_kind,
                self.scope,
                uri,
            )
            return
        normalized = normalize_lsp_diagnostics(rel, params.get('diagnostics') if isinstance(params, dict) else [])
        with self._lock:
            self._diag_cache()[rel] = normalized
            self._diag_generation[rel] = self._diag_generation.get(rel, 0) + 1
            self._diag_cond.notify_all()
        # High churn for TS/JS (publishDiagnostics on many internal passes); keep health / INFO logs usable.
        logger.debug(
            '%s diagnostics refreshed session=%s scope=%s path=%s count=%s',
            self.server_kind,
            self.session_id,
            self.scope,
            rel,
            len(normalized),
        )

    def _wait_for_diagnostics(self, relative_path: str, previous_generation: int) -> None:
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            with self._lock:
                if self._diag_generation.get(relative_path, 0) > previous_generation:
                    return
                self._diag_cond.wait(timeout=max(0.05, min(0.2, remaining)))

    def _require_client(self) -> JsonRpcLspClient:
        if self._client is None:
            raise RuntimeError(f'{self.server_kind} LSP client is not initialized.')
        return self._client

    def is_client_running(self) -> bool:
        return self._client is not None


PythonLspManager = SessionWorkspaceLspManager


def _resolve_session_and_root(session_id: str | None) -> tuple[str, SessionState, Path]:
    sid = (session_id or current_session_id.get() or '').strip()
    if not sid:
        raise ValueError('No active session is available for LSP.')
    session = get_session(sid)
    if not session.workspace_path:
        raise ValueError('This conversation does not have a workspace attached.')
    return sid, session, Path(session.workspace_path).resolve()


def _effective_lsp_workspace_root(session: SessionState, scope: str, *, session_id: str) -> Path:
    desired = _normalize_lsp_scope(scope)
    if desired == 'workspace':
        return Path(session.workspace.workspace_path).resolve()
    return ensure_lsp_staging_overlay(session, Path(session.workspace.workspace_path), session_id=session_id)


def activate_session_lsp_scope(session_id: str | None = None, *, scope: str) -> None:
    """Set the session's default LSP scope without tearing down the other scope's managers."""

    _sid, session, _workspace_root = _resolve_session_and_root(session_id)
    session.lsp.lsp_active_scope = _normalize_lsp_scope(scope)


def get_session_lsp_manager(
    session_id: str | None = None,
    *,
    client_factory: Any | None = None,
    scope: str | None = None,
    server: str = 'python',
    set_active: bool = True,
) -> SessionWorkspaceLspManager:
    sid, session, _real_ws = _resolve_session_and_root(session_id)
    server_id = (server or '').strip()
    get_lsp_server_plugin(server_id)  # validate early
    desired_scope = _normalize_lsp_scope(scope or session.lsp.lsp_active_scope)
    effective_root = _effective_lsp_workspace_root(session, desired_scope, session_id=sid)
    key = (sid, server_id, desired_scope)
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.get(key)
        if manager is not None and manager.workspace_root != effective_root:
            manager.shutdown()
            _SESSION_MANAGERS.pop(key, None)
            manager = None
        if manager is None:
            manager = SessionWorkspaceLspManager(
                session_id=sid,
                session=session,
                workspace_root=effective_root,
                scope=desired_scope,
                server_kind=server_id,
                client_factory=client_factory,
            )
            _SESSION_MANAGERS[key] = manager
        # Explicit scope selection updates the session default unless the caller opts out
        # (e.g. read-only diagnostics against the non-default scope).
        if set_active and scope is not None:
            session.lsp.lsp_active_scope = desired_scope
        return manager


def shutdown_session_lsp_server(session_id: str, server_id: str) -> None:
    """Stop language-server managers for one server id on this session (all scopes)."""

    sid = (session_id or '').strip()
    if not sid:
        return
    srv = (server_id or '').strip()
    with _MANAGERS_LOCK:
        keys = [k for k in list(_SESSION_MANAGERS.keys()) if k[0] == sid and k[1] == srv]
        managers = [_SESSION_MANAGERS.pop(k) for k in keys]
    for manager in managers:
        manager.shutdown()


def shutdown_session_python_lsp(session_id: str) -> None:
    """Stop only the Python language-server manager for this session (e.g. after interpreter change)."""

    shutdown_session_lsp_server(session_id, 'python')


def shutdown_session_lsp(session_id: str) -> None:
    with _MANAGERS_LOCK:
        keys = [k for k in list(_SESSION_MANAGERS.keys()) if k[0] == session_id]
        managers = [_SESSION_MANAGERS.pop(k) for k in keys]
    for mgr in managers:
        mgr.shutdown()
    try:
        session = get_session(session_id)
        clear_diagnostics_caches(session)
        clear_lsp_staging_overlay(session)
    except Exception as exc:
        logger.warning('clear LSP staging overlay failed session=%s err=%s', session_id, exc)


def shutdown_all_lsp_managers() -> None:
    with _MANAGERS_LOCK:
        items = list(_SESSION_MANAGERS.items())
        _SESSION_MANAGERS.clear()
    cleared_sessions: set[str] = set()
    for _key, manager in items:
        manager.shutdown()
        sid = manager.session_id
        if sid not in cleared_sessions:
            cleared_sessions.add(sid)
            try:
                session = get_session(sid)
                clear_diagnostics_caches(session)
                clear_lsp_staging_overlay(session)
            except Exception as exc:
                logger.warning('clear LSP staging overlay failed session=%s err=%s', sid, exc)


def count_active_lsp_sessions() -> dict[str, Any]:
    """Count distinct sessions / managers with a live language-server client (no session id required)."""

    with _MANAGERS_LOCK:
        session_ids: set[str] = set()
        managers_running = 0
        for (sid, _srv, _scope), mgr in _SESSION_MANAGERS.items():
            if mgr.is_client_running():
                session_ids.add(sid)
                managers_running += 1
        return {
            'activeSessions': len(session_ids),
            'runningManagers': managers_running,
            'sessionIds': sorted(session_ids),
        }


def get_lsp_dashboard_status(session_id: str) -> dict[str, Any]:
    """Summarize workspace LSP without starting language-server processes."""

    sid, session, workspace_root = _resolve_session_and_root(session_id)
    with _MANAGERS_LOCK:
        servers_payload: dict[str, dict[str, bool]] = {}
        for srv_id in iter_registered_lsp_server_ids():
            running = any(
                k[0] == sid and k[1] == srv_id and mgr.is_client_running()
                for k, mgr in _SESSION_MANAGERS.items()
            )
            servers_payload[srv_id] = {'initialized': running}
    diag_count = sum(
        len(rows)
        for cache in session.lsp.lsp_diagnostics_by_scope.values()
        for rows in cache.values()
    )
    active_scope = session.lsp.lsp_active_scope or 'workspace'
    real_ws = str(workspace_root)
    overlay_raw = str(getattr(session.lsp, 'lsp_staging_overlay_root', '') or '').strip()
    reported_root = overlay_raw if active_scope == 'staging' and overlay_raw else real_ws
    ts_root_str = (session.lsp.typescript_lsp_resolved_root or '').strip()
    node_modules_present = False
    if ts_root_str:
        node_modules_present = (Path(ts_root_str).resolve() / 'node_modules').is_dir()
    py_env_path = jedi_environment_path_for_workspace(session, workspace_root)
    py_interp = (session.workspace.python_workspace_python_executable or '').strip() or None

    return {
        'sessionId': sid,
        'workspaceRoot': reported_root,
        'realWorkspaceRoot': real_ws,
        'typescriptProjectRoot': session.lsp.typescript_lsp_resolved_root or None,
        'javaProjectRoot': session.lsp.java_lsp_resolved_root or None,
        'activeLspScope': active_scope,
        'cachedDiagnostics': diag_count,
        'diagnosticsCacheNote': (
            'Per-scope cache (workspace and staging managers can run together); '
            'clears when that scope\'s manager shuts down or the session LSP is reset.'
        ),
        'pythonEnvironmentPath': py_env_path,
        'pythonInterpreterPath': py_interp,
        'nodeModulesPresent': node_modules_present,
        'servers': servers_payload,
    }


def list_session_diagnostics(
    session_id: str, relative_path: str = '', *, scope: str | None = None
) -> list[dict[str, Any]]:
    sid, session, _ = _resolve_session_and_root(session_id)
    cache = diagnostics_cache_for_scope(session, scope or session.lsp.lsp_active_scope)
    rel = normalize_relative_posix_path(relative_path)
    if rel:
        return list(cache.get(rel, []))
    all_items: list[dict[str, Any]] = []
    for path in sorted(cache):
        all_items.extend(cache[path])
    return all_items


def sync_session_document(
    relative_path: str,
    text: str,
    *,
    session_id: str | None = None,
    scope: str | None = None,
    wait_for_diagnostics: bool = True,
) -> list[dict[str, Any]]:
    sid = (session_id or current_session_id.get() or '').strip() or None
    server = lsp_server_for_path(relative_path)
    if not server:
        raise ValueError(f'No LSP server is configured for `{relative_path}`.')
    try:
        manager = get_session_lsp_manager(sid, scope=scope, server=server)
        return manager.sync_document(relative_path, text, wait_for_diagnostics=wait_for_diagnostics)
    except Exception as exc:
        if sid is None or not _should_retry_lsp_bootstrap(exc):
            raise
        logger.warning('retrying LSP sync after bootstrap failure session=%s server=%s err=%s', sid, server, exc)
        shutdown_session_lsp_server(sid, server)
        manager = get_session_lsp_manager(sid, scope=scope, server=server)
        return manager.sync_document(relative_path, text, wait_for_diagnostics=wait_for_diagnostics)


def close_session_document(
    relative_path: str,
    *,
    session_id: str | None = None,
    scope: str | None = None,
) -> None:
    server = lsp_server_for_path(relative_path)
    if not server:
        return
    manager = get_session_lsp_manager(session_id, scope=scope, server=server)
    manager.close_document(relative_path)
