"""Session-scoped Python LSP manager and cache."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from nemo_backend.domain import SessionState
from nemo_backend.lsp.client import JsonRpcLspClient
from nemo_backend.lsp.diagnostics import normalize_lsp_diagnostics
from nemo_backend.lsp.file_policy import get_python_lsp_policy, is_lsp_managed_path, normalize_relative_posix_path
from nemo_backend.lsp.python_server import build_python_lsp_command
from nemo_backend.state import current_session_id, get_session
from nemo_backend.workspace_text_io import read_file_for_tools, validate_workspace_encoding
from nemo_backend.workspace_tools import normalize_relative_path

logger = logging.getLogger('nemo.lsp.manager')

__all__ = [
    'PythonLspManager',
    'activate_session_lsp_scope',
    'get_session_lsp_manager',
    'shutdown_session_lsp',
    'shutdown_all_lsp_managers',
    'list_session_diagnostics',
    'sync_session_document',
    'close_session_document',
]

_MANAGERS_LOCK = threading.RLock()
_SESSION_MANAGERS: dict[str, PythonLspManager] = {}
_VALID_LSP_SCOPES = frozenset({'workspace', 'staging'})


def _normalize_lsp_scope(scope: str | None) -> str:
    value = (scope or '').strip().lower() or 'workspace'
    if value not in _VALID_LSP_SCOPES:
        raise ValueError(f'Unsupported Python LSP scope: {scope!r}')
    return value


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
            'documentSymbol': {
                'hierarchicalDocumentSymbolSupport': True,
                'symbolKind': {'valueSet': list(range(1, 27))},
            },
            'publishDiagnostics': {'relatedInformation': True},
            'synchronization': {'didSave': True, 'dynamicRegistration': False},
        },
        'workspace': {
            'workspaceFolders': True,
            'didChangeWatchedFiles': {'dynamicRegistration': False},
        },
    }


class PythonLspManager:
    """Owns one Python language-server process for a session/workspace pair."""

    def __init__(
        self,
        *,
        session_id: str,
        session: SessionState,
        workspace_root: Path,
        scope: str,
        client_factory: Any | None = None,
    ) -> None:
        self.session_id = session_id
        self.session = session
        self.workspace_root = Path(workspace_root).resolve()
        self.scope = _normalize_lsp_scope(scope)
        self._client_factory = client_factory
        self._client: JsonRpcLspClient | None = None
        self._lock = threading.RLock()
        self._diag_cond = threading.Condition(self._lock)
        self._doc_versions: dict[str, int] = {}
        self._diag_generation: dict[str, int] = {}

    def ensure_started(self) -> None:
        with self._lock:
            if self._client is not None:
                return
            command = build_python_lsp_command(self.workspace_root)
            factory = self._client_factory or (
                lambda *, command, workspace_root, notification_handler: JsonRpcLspClient(
                    command,
                    workspace_root=workspace_root,
                    notification_handler=notification_handler,
                )
            )
            client = factory(
                command=command,
                workspace_root=self.workspace_root,
                notification_handler=self._handle_notification,
            )
            client.initialize(
                root_uri=_path_to_uri(self.workspace_root),
                process_id=os.getpid(),
                capabilities=_workspace_capabilities(),
            )
            self._client = client
            self.session.lsp_workspace_root = str(self.workspace_root)
            self.session.lsp_active_scope = self.scope
            logger.info(
                'python LSP session ready session=%s scope=%s workspace=%s',
                self.session_id,
                self.scope,
                self.workspace_root,
            )

    def shutdown(self) -> None:
        with self._lock:
            client = self._client
            self._client = None
            self._doc_versions.clear()
            self._diag_generation.clear()
            self.session.lsp_diagnostics.clear()
            self.session.lsp_workspace_root = ''
            if self.session.lsp_active_scope == self.scope:
                self.session.lsp_active_scope = 'workspace'
        if client is not None:
            try:
                client.shutdown()
            except Exception as exc:
                logger.warning(
                    'python LSP shutdown failed session=%s scope=%s err=%s',
                    self.session_id,
                    self.scope,
                    exc,
                )

    def sync_document(self, relative_path: str, text: str) -> list[dict[str, Any]]:
        rel = normalize_relative_posix_path(relative_path)
        policy = get_python_lsp_policy(rel)
        if policy is None:
            raise ValueError(f'LSP sync is not supported for `{rel}`.')
        self.ensure_started()
        path = normalize_relative_path(self.workspace_root, rel)
        uri = _path_to_uri(path)
        with self._lock:
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
                    'python LSP didOpen session=%s scope=%s path=%s version=%s',
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
                    'python LSP didChange session=%s scope=%s path=%s version=%s',
                    self.session_id,
                    self.scope,
                    rel,
                    version,
                )
            self._wait_for_diagnostics(rel, prev_generation)
            return list(self.session.lsp_diagnostics.get(rel, []))

    def sync_workspace_document(self, relative_path: str, *, encoding: str = 'utf-8') -> list[dict[str, Any]]:
        rel = normalize_relative_posix_path(relative_path)
        enc = validate_workspace_encoding(encoding)
        target = normalize_relative_path(self.workspace_root, rel)
        text = read_file_for_tools(target, enc)
        return self.sync_document(rel, text)

    def close_document(self, relative_path: str) -> None:
        rel = normalize_relative_posix_path(relative_path)
        if not is_lsp_managed_path(rel):
            return
        with self._lock:
            client = self._client
            if client is None or rel not in self._doc_versions:
                self.session.lsp_diagnostics.pop(rel, None)
                return
            target = normalize_relative_path(self.workspace_root, rel)
            client.notify('textDocument/didClose', {'textDocument': {'uri': _path_to_uri(target)}})
            self._doc_versions.pop(rel, None)
            self.session.lsp_diagnostics.pop(rel, None)
            self._diag_generation.pop(rel, None)
            logger.info('python LSP didClose session=%s scope=%s path=%s', self.session_id, self.scope, rel)

    def get_diagnostics(self, relative_path: str = '') -> list[dict[str, Any]]:
        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            if rel:
                return list(self.session.lsp_diagnostics.get(rel, []))
            all_items: list[dict[str, Any]] = []
            for path in sorted(self.session.lsp_diagnostics):
                all_items.extend(self.session.lsp_diagnostics[path])
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

    def _ensure_workspace_synced(self, relative_path: str) -> str:
        rel = normalize_relative_posix_path(relative_path)
        if not is_lsp_managed_path(rel):
            raise ValueError(f'LSP tools only support Python files in v1. Got `{rel}`.')
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
            rel = normalize_relative_path(self.workspace_root, _uri_to_path(uri).relative_to(self.workspace_root).as_posix()).relative_to(self.workspace_root).as_posix()
        except Exception:
            logger.debug(
                'ignoring diagnostics outside workspace session=%s scope=%s uri=%s',
                self.session_id,
                self.scope,
                uri,
            )
            return
        normalized = normalize_lsp_diagnostics(rel, params.get('diagnostics') if isinstance(params, dict) else [])
        with self._lock:
            self.session.lsp_diagnostics[rel] = normalized
            self._diag_generation[rel] = self._diag_generation.get(rel, 0) + 1
            self._diag_cond.notify_all()
        logger.info(
            'python diagnostics refreshed session=%s scope=%s path=%s count=%s',
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
            raise RuntimeError('Python LSP client is not initialized.')
        return self._client


def _resolve_session_and_root(session_id: str | None) -> tuple[str, SessionState, Path]:
    sid = (session_id or current_session_id.get() or '').strip()
    if not sid:
        raise ValueError('No active session is available for Python LSP.')
    session = get_session(sid)
    if not session.workspace_path:
        raise ValueError('This conversation does not have a workspace attached.')
    return sid, session, Path(session.workspace_path).resolve()


def activate_session_lsp_scope(session_id: str | None = None, *, scope: str) -> None:
    sid, session, workspace_root = _resolve_session_and_root(session_id)
    desired_scope = _normalize_lsp_scope(scope)
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.get(sid)
        if manager is not None and (
            manager.workspace_root != workspace_root or manager.scope != desired_scope
        ):
            _SESSION_MANAGERS.pop(sid, None)
            manager.shutdown()
            manager = None
        session.lsp_active_scope = desired_scope
        if manager is None:
            session.lsp_workspace_root = ''
            session.lsp_diagnostics.clear()


def get_session_lsp_manager(
    session_id: str | None = None,
    *,
    client_factory: Any | None = None,
    scope: str | None = None,
) -> PythonLspManager:
    sid, session, workspace_root = _resolve_session_and_root(session_id)
    desired_scope = _normalize_lsp_scope(scope or session.lsp_active_scope)
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.get(sid)
        if manager is not None and (
            manager.workspace_root != workspace_root or manager.scope != desired_scope
        ):
            manager.shutdown()
            _SESSION_MANAGERS.pop(sid, None)
            manager = None
        if manager is None:
            manager = PythonLspManager(
                session_id=sid,
                session=session,
                workspace_root=workspace_root,
                scope=desired_scope,
                client_factory=client_factory,
            )
            _SESSION_MANAGERS[sid] = manager
        session.lsp_active_scope = desired_scope
        return manager


def shutdown_session_lsp(session_id: str) -> None:
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.pop(session_id, None)
    if manager is not None:
        manager.shutdown()


def shutdown_all_lsp_managers() -> None:
    with _MANAGERS_LOCK:
        items = list(_SESSION_MANAGERS.items())
        _SESSION_MANAGERS.clear()
    for _session_id, manager in items:
        manager.shutdown()


def list_session_diagnostics(
    session_id: str, relative_path: str = '', *, scope: str | None = None
) -> list[dict[str, Any]]:
    manager = get_session_lsp_manager(session_id, scope=scope)
    return manager.get_diagnostics(relative_path)


def sync_session_document(
    relative_path: str,
    text: str,
    *,
    session_id: str | None = None,
    scope: str | None = None,
) -> list[dict[str, Any]]:
    sid = (session_id or current_session_id.get() or '').strip() or None
    try:
        manager = get_session_lsp_manager(sid, scope=scope)
        return manager.sync_document(relative_path, text)
    except Exception as exc:
        if sid is None or not _should_retry_lsp_bootstrap(exc):
            raise
        logger.warning('retrying python LSP sync after bootstrap failure session=%s err=%s', sid, exc)
        shutdown_session_lsp(sid)
        manager = get_session_lsp_manager(sid, scope=scope)
        return manager.sync_document(relative_path, text)


def close_session_document(
    relative_path: str,
    *,
    session_id: str | None = None,
    scope: str | None = None,
) -> None:
    manager = get_session_lsp_manager(session_id, scope=scope)
    manager.close_document(relative_path)
