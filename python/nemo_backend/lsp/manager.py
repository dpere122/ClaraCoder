"""Session-scoped LSP managers (Python + TypeScript/JavaScript) and diagnostics cache."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from nemo_backend.domain import SessionState
from nemo_backend.lsp.client import JsonRpcLspClient
from nemo_backend.lsp.diagnostics import normalize_lsp_diagnostics
from nemo_backend.lsp.file_policy import get_lsp_file_policy, lsp_server_for_path, normalize_relative_posix_path
from nemo_backend.lsp.jedi_init_options import (
    build_jedi_initialization_options,
    jedi_environment_path_for_workspace,
)
from nemo_backend.lsp.python_server import build_python_lsp_command
from nemo_backend.lsp.typescript_project_root import resolve_typescript_project_root
from nemo_backend.lsp.typescript_server import build_typescript_lsp_command
from nemo_backend.state import current_session_id, get_session
from nemo_backend.workspace_text_io import read_file_for_tools, validate_workspace_encoding
from nemo_backend.workspace_tools import normalize_relative_path

logger = logging.getLogger('nemo.lsp.manager')

LspServerKind = Literal['python', 'typescript']

__all__ = [
    'PythonLspManager',
    'SessionWorkspaceLspManager',
    'activate_session_lsp_scope',
    'get_session_lsp_manager',
    'get_lsp_dashboard_status',
    'shutdown_session_lsp',
    'shutdown_session_python_lsp',
    'shutdown_all_lsp_managers',
    'list_session_diagnostics',
    'sync_session_document',
    'close_session_document',
]

_MANAGERS_LOCK = threading.RLock()
_SESSION_MANAGERS: dict[tuple[str, LspServerKind], SessionWorkspaceLspManager] = {}
_VALID_LSP_SCOPES = frozenset({'workspace', 'staging'})


def _normalize_lsp_scope(scope: str | None) -> str:
    value = (scope or '').strip().lower() or 'workspace'
    if value not in _VALID_LSP_SCOPES:
        raise ValueError(f'Unsupported LSP scope: {scope!r}')
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
    """Owns one language-server process (Python or TypeScript) for a session/workspace/scope tuple."""

    def __init__(
        self,
        *,
        session_id: str,
        session: SessionState,
        workspace_root: Path,
        scope: str,
        server_kind: LspServerKind,
        client_factory: Any | None = None,
    ) -> None:
        self.session_id = session_id
        self.session = session
        self.workspace_root = Path(workspace_root).resolve()
        self.scope = _normalize_lsp_scope(scope)
        self.server_kind: LspServerKind = server_kind
        self._client_factory = client_factory
        self._client: JsonRpcLspClient | None = None
        self._lock = threading.RLock()
        self._diag_cond = threading.Condition(self._lock)
        self._doc_versions: dict[str, int] = {}
        self._diag_generation: dict[str, int] = {}
        #: Effective cwd / LSP rootUri for typescript-language-server (nested package); ``None`` until first start.
        self._typescript_project_root: Path | None = None
        self._last_typescript_seed: str = ''
        #: From ``initialize`` response (``semanticTokensProvider.legend``); ``None`` if unsupported.
        self._semantic_tokens_legend: dict[str, list[str]] | None = None

    def _build_command(self) -> list[str]:
        if self.server_kind == 'python':
            return build_python_lsp_command(self.workspace_root)
        root = self._typescript_project_root or self.workspace_root
        return build_typescript_lsp_command(root)

    def _policy(self, rel: str) -> Any:
        policy = get_lsp_file_policy(rel)
        if policy is None or policy.lsp_server != self.server_kind:
            return None
        return policy

    def should_skip_typescript_cold_start_without_seed(self) -> bool:
        """Avoid spawning typescript-language-server before any TS/JS path is known.

        Without a seed path, project-root discovery often falls back to the session workspace,
        which binds the wrong ``tsconfig.json`` for nested packages; Monaco prefetch must not
        lock the server to that root before ``sync_document`` runs.
        """

        return self.server_kind == 'typescript' and not (self._last_typescript_seed or '').strip()

    def ensure_started(self) -> None:
        with self._lock:
            if self._client is not None:
                return
            lsp_cwd = self.workspace_root
            if self.server_kind == 'typescript':
                self._typescript_project_root = resolve_typescript_project_root(
                    self.workspace_root,
                    seed_relative_path=self._last_typescript_seed or None,
                )
                lsp_cwd = self._typescript_project_root
                self.session.typescript_lsp_resolved_root = str(self._typescript_project_root)
            command = self._build_command()
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
            # jedi-language-server: semantic tokens off by default; workspace.environmentPath
            # aligns Jedi with the workspace venv so library hovers resolve installed packages.
            init_opts: dict[str, Any] = {}
            if self.server_kind == 'python':
                init_opts = build_jedi_initialization_options(self.session, self.workspace_root)
            init_result = client.initialize(
                root_uri=_path_to_uri(lsp_cwd),
                process_id=os.getpid(),
                capabilities=_workspace_capabilities(),
                initialization_options=init_opts,
            )
            self._semantic_tokens_legend = _extract_semantic_tokens_legend(init_result)
            self._client = client
            self.session.lsp_workspace_root = str(self.workspace_root)
            self.session.lsp_active_scope = self.scope
            logger.info(
                '%s LSP session ready session=%s scope=%s workspace=%s lsp_cwd=%s',
                self.server_kind,
                self.session_id,
                self.scope,
                self.workspace_root,
                lsp_cwd,
            )

    def shutdown(self) -> None:
        with self._lock:
            client = self._client
            self._client = None
            self._semantic_tokens_legend = None
            tracked = list(self._doc_versions.keys())
            self._doc_versions.clear()
            self._diag_generation.clear()
            for rel in tracked:
                self.session.lsp_diagnostics.pop(rel, None)
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
        my_key = (self.session_id, self.server_kind)
        with _MANAGERS_LOCK:
            any_remaining = any(
                k != my_key and k[0] == self.session_id for k in _SESSION_MANAGERS
            )
        if not any_remaining:
            self.session.lsp_workspace_root = ''
            if self.session.lsp_active_scope == self.scope:
                self.session.lsp_active_scope = 'workspace'
        if self.server_kind == 'typescript':
            self.session.typescript_lsp_resolved_root = ''
            self._typescript_project_root = None

    def sync_document(self, relative_path: str, text: str) -> list[dict[str, Any]]:
        rel = normalize_relative_posix_path(relative_path)
        policy = self._policy(rel)
        if policy is None:
            raise ValueError(f'LSP sync is not supported for `{rel}` on {self.server_kind} server.')
        if self.server_kind == 'typescript':
            self._last_typescript_seed = rel
            desired_root = resolve_typescript_project_root(
                self.workspace_root,
                seed_relative_path=self._last_typescript_seed,
            )
            with self._lock:
                running = self._client is not None
                cur_root = self._typescript_project_root
            if running and cur_root is not None:
                try:
                    mismatch = desired_root.resolve() != cur_root.resolve()
                except OSError:
                    mismatch = True
                if mismatch:
                    logger.info(
                        'typescript LSP project root changed %s -> %s; restarting server session=%s',
                        cur_root,
                        desired_root,
                        self.session_id,
                    )
                    self.shutdown()
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
        if self._policy(rel) is None:
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

    @property
    def semantic_tokens_legend(self) -> dict[str, list[str]] | None:
        """Cached legend from the language server's ``initialize`` response (may be ``None``)."""

        return self._semantic_tokens_legend

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
            self.session.lsp_diagnostics[rel] = normalized
            self._diag_generation[rel] = self._diag_generation.get(rel, 0) + 1
            self._diag_cond.notify_all()
        logger.info(
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
        return Path(session.workspace_path).resolve()
    from nemo_backend.staging_test_overlay import ensure_lsp_staging_overlay

    return ensure_lsp_staging_overlay(session, Path(session.workspace_path), session_id=session_id)


def activate_session_lsp_scope(session_id: str | None = None, *, scope: str) -> None:
    from nemo_backend.staging_test_overlay import clear_lsp_staging_overlay

    sid, session, _workspace_root = _resolve_session_and_root(session_id)
    desired_scope = _normalize_lsp_scope(scope)
    with _MANAGERS_LOCK:
        keys = [k for k in list(_SESSION_MANAGERS.keys()) if k[0] == sid]
        managers = [_SESSION_MANAGERS.pop(k) for k in keys]
    for mgr in managers:
        mgr.shutdown()
    session.lsp_active_scope = desired_scope
    session.lsp_workspace_root = ''
    session.typescript_lsp_resolved_root = ''
    session.lsp_diagnostics.clear()
    if desired_scope == 'workspace':
        clear_lsp_staging_overlay(session)


def get_session_lsp_manager(
    session_id: str | None = None,
    *,
    client_factory: Any | None = None,
    scope: str | None = None,
    server: LspServerKind = 'python',
) -> SessionWorkspaceLspManager:
    sid, session, _real_ws = _resolve_session_and_root(session_id)
    desired_scope = _normalize_lsp_scope(scope or session.lsp_active_scope)
    effective_root = _effective_lsp_workspace_root(session, desired_scope, session_id=sid)
    key = (sid, server)
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.get(key)
        if manager is not None and (
            manager.workspace_root != effective_root or manager.scope != desired_scope
        ):
            manager.shutdown()
            _SESSION_MANAGERS.pop(key, None)
            manager = None
        if manager is None:
            manager = SessionWorkspaceLspManager(
                session_id=sid,
                session=session,
                workspace_root=effective_root,
                scope=desired_scope,
                server_kind=server,
                client_factory=client_factory,
            )
            _SESSION_MANAGERS[key] = manager
        session.lsp_active_scope = desired_scope
        return manager


def shutdown_session_python_lsp(session_id: str) -> None:
    """Stop only the Python language-server manager for this session (e.g. after interpreter change)."""

    sid = (session_id or '').strip()
    if not sid:
        return
    with _MANAGERS_LOCK:
        key = (sid, 'python')
        manager = _SESSION_MANAGERS.pop(key, None)
    if manager is not None:
        manager.shutdown()


def shutdown_session_lsp(session_id: str) -> None:
    from nemo_backend.staging_test_overlay import clear_lsp_staging_overlay

    with _MANAGERS_LOCK:
        keys = [k for k in list(_SESSION_MANAGERS.keys()) if k[0] == session_id]
        managers = [_SESSION_MANAGERS.pop(k) for k in keys]
    for mgr in managers:
        mgr.shutdown()
    try:
        session = get_session(session_id)
        clear_lsp_staging_overlay(session)
    except Exception as exc:
        logger.warning('clear LSP staging overlay failed session=%s err=%s', session_id, exc)


def shutdown_all_lsp_managers() -> None:
    from nemo_backend.staging_test_overlay import clear_lsp_staging_overlay

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
                clear_lsp_staging_overlay(get_session(sid))
            except Exception as exc:
                logger.warning('clear LSP staging overlay failed session=%s err=%s', sid, exc)


def get_lsp_dashboard_status(session_id: str) -> dict[str, Any]:
    """Summarize workspace LSP without starting language-server processes."""

    sid, session, workspace_root = _resolve_session_and_root(session_id)
    with _MANAGERS_LOCK:
        py = _SESSION_MANAGERS.get((sid, 'python'))
        ts = _SESSION_MANAGERS.get((sid, 'typescript'))
    diag_count = sum(len(v) for v in session.lsp_diagnostics.values())
    active_scope = session.lsp_active_scope or 'workspace'
    real_ws = str(workspace_root)
    overlay_raw = str(getattr(session, 'lsp_staging_overlay_root', '') or '').strip()
    reported_root = overlay_raw if active_scope == 'staging' and overlay_raw else real_ws
    ts_root_str = (session.typescript_lsp_resolved_root or '').strip()
    if ts_root_str:
        ts_base = Path(ts_root_str).resolve()
    else:
        ts_base = resolve_typescript_project_root(workspace_root, seed_relative_path=None)
    node_modules_present = (ts_base / 'node_modules').is_dir()
    py_env_path = jedi_environment_path_for_workspace(session, workspace_root)
    py_interp = (session.python_workspace_python_executable or '').strip() or None

    return {
        'sessionId': sid,
        'workspaceRoot': reported_root,
        'realWorkspaceRoot': real_ws,
        'typescriptProjectRoot': session.typescript_lsp_resolved_root or None,
        'activeLspScope': active_scope,
        'cachedDiagnostics': diag_count,
        'diagnosticsCacheNote': 'Session-scoped cache only; clears when LSP scope changes (workspace vs staging).',
        'pythonEnvironmentPath': py_env_path,
        'pythonInterpreterPath': py_interp,
        'nodeModulesPresent': node_modules_present,
        'servers': {
            'python': {'initialized': py is not None and py.is_client_running()},
            'typescript': {'initialized': ts is not None and ts.is_client_running()},
        },
    }


def list_session_diagnostics(
    session_id: str, relative_path: str = '', *, scope: str | None = None
) -> list[dict[str, Any]]:
    sid, session, _ = _resolve_session_and_root(session_id)
    _normalize_lsp_scope(scope or session.lsp_active_scope)
    rel = normalize_relative_posix_path(relative_path)
    if rel:
        return list(session.lsp_diagnostics.get(rel, []))
    all_items: list[dict[str, Any]] = []
    for path in sorted(session.lsp_diagnostics):
        all_items.extend(session.lsp_diagnostics[path])
    return all_items


def sync_session_document(
    relative_path: str,
    text: str,
    *,
    session_id: str | None = None,
    scope: str | None = None,
) -> list[dict[str, Any]]:
    sid = (session_id or current_session_id.get() or '').strip() or None
    server = lsp_server_for_path(relative_path)
    if not server:
        raise ValueError(f'No LSP server is configured for `{relative_path}`.')
    try:
        manager = get_session_lsp_manager(sid, scope=scope, server=server)
        return manager.sync_document(relative_path, text)
    except Exception as exc:
        if sid is None or not _should_retry_lsp_bootstrap(exc):
            raise
        logger.warning('retrying LSP sync after bootstrap failure session=%s server=%s err=%s', sid, server, exc)
        shutdown_session_lsp(sid)
        manager = get_session_lsp_manager(sid, scope=scope, server=server)
        return manager.sync_document(relative_path, text)


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
