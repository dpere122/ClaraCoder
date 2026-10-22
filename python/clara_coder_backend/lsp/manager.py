"""Session-scoped LSP managers and diagnostics cache (pluggable server backends)."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import stat as stat_module
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from clara_coder_backend.domain import SessionState
from clara_coder_backend.lsp.client import JsonRpcLspClient
from clara_coder_backend.lsp.diagnostics import normalize_lsp_diagnostics
from clara_coder_backend.lsp.file_policy import get_lsp_file_policy, lsp_server_for_path, normalize_relative_posix_path
from clara_coder_backend.lsp.python_init_options import python_environment_path_for_workspace
from clara_coder_backend.lsp.registry import (
    LspServerKind,
    get_lsp_server_plugin,
    iter_registered_lsp_server_ids,
)
from clara_coder_backend.lsp.server_plugin import LspServerPlugin
from clara_coder_backend.lsp.overlay_hooks import clear_lsp_staging_overlay
from clara_coder_backend.session.state import current_session_id, get_session, sessions
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
    'shutdown_session_lsp_scope',
    'shutdown_session_python_lsp',
    'shutdown_all_lsp_managers',
    'list_session_diagnostics',
    'sync_session_document',
    'session_diagnostics_fresh',
    'notify_session_lsp_disk_changes',
    'close_session_document',
    'DOC_ORIGIN_DISK',
    'DOC_ORIGIN_EDITOR',
    'LspServerKind',
    'java_workspace_is_ready',
]

_MANAGERS_LOCK = threading.RLock()
# Keyed by (session_id, server_id, scope) so workspace + staging managers can coexist.
_SESSION_MANAGERS: dict[tuple[str, str, str], SessionWorkspaceLspManager] = {}
_VALID_LSP_SCOPES = frozenset({'workspace', 'staging'})
_JAVA_WAIT_READY_TIMEOUT_S = 8.0
_JAVA_STARTING_GRACE_S = 5.0
_JAVA_NO_STATUS_GRACE_S = 3.0
_DIAG_WAIT_TIMEOUT_S = 1.5
_DIAG_WAIT_TIMEOUT_SLOW_S = 2.5
# First publish after ``didOpen`` includes the server's cold analysis of the project.
_DIAG_FIRST_OPEN_TIMEOUT_S = 5.0
_DIAG_FIRST_OPEN_TIMEOUT_SLOW_S = 8.0
_DIAG_QUIET_S = 0.05

# Who last supplied a document's text: the Monaco editor (may be unsaved) or the file on disk.
DOC_ORIGIN_EDITOR = 'editor'
DOC_ORIGIN_DISK = 'disk'

# ``FileChangeType`` for ``workspace/didChangeWatchedFiles`` per Electron watcher change kind.
_WATCHED_FILE_CHANGE_TYPES = {'created': 1, 'renamed': 1, 'updated': 2, 'unknown': 2, 'deleted': 3}


def java_workspace_is_ready(status: str, message: str = '') -> bool:
    """True when JDT ``language/status`` means completions can be served."""

    st = (status or '').strip().lower()
    msg = (message or '').strip().lower()
    if st in {'started', 'serviceready'}:
        return True
    if st == 'projectstatus' and msg in {'ok', 'ready'}:
        return True
    return False


_LIFECYCLE_PHASE_RANK = {
    'idle': 0,
    'running': 10,
    'crashed': 20,
    'indexing': 30,
    'initializing': 40,
    'starting': 50,
    'shuttingDown': 60,
}


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


def _disk_stat_of(path: Path) -> tuple[int, int] | None:
    """``(mtime_ns, size)`` of a regular file, or None when it does not exist."""

    try:
        st = path.stat()
    except OSError:
        return None
    if not stat_module.S_ISREG(st.st_mode):
        return None
    return (st.st_mtime_ns, st.st_size)


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
            'configuration': True,
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


# LSP line breaks are exactly ``\r\n``, ``\r`` and ``\n`` (``str.splitlines`` also splits on
# ``\v``/``\f``/``\u2028``… which language servers treat as ordinary characters).
_LSP_LINE_BREAK_RE = re.compile(r'\r\n|\r|\n')
_TEXT_DOCUMENT_SYNC_INCREMENTAL = 2


def _lsp_document_end_position(text: str) -> dict[str, int]:
    """``Position`` just past the last character of ``text`` (UTF-16 ``character`` units)."""

    last_break_end = 0
    line = 0
    for match in _LSP_LINE_BREAK_RE.finditer(text):
        line += 1
        last_break_end = match.end()
    last_line = text[last_break_end:]
    return {'line': line, 'character': len(last_line.encode('utf-16-le')) // 2}


def _server_uses_incremental_sync(server_capabilities: dict[str, Any]) -> bool:
    """True when ``initialize`` advertised ``textDocumentSync.change == Incremental``."""

    sync = server_capabilities.get('textDocumentSync')
    if isinstance(sync, dict):
        sync = sync.get('change')
    return sync == _TEXT_DOCUMENT_SYNC_INCREMENTAL


def _full_replace_content_changes(
    text: str,
    *,
    previous_end: dict[str, int] | None,
    incremental: bool,
) -> list[dict[str, Any]]:
    """Build ``didChange.contentChanges`` that replace the whole buffer with ``text``.

    Servers that advertise *incremental* sync are sent one ranged edit spanning the
    previously synced document. vtsls (TypeScript) needs this: given a range-less
    ``{text}`` change it fabricates ``Range(0, 0, newLineCount, 0)`` against the buffer
    tsserver still holds, so tsserver either aborts with ``Debug Failure. Bad line
    number`` (crashing and restarting the whole server tree) or, when the new text has
    fewer lines, silently keeps stale trailing lines and reports phantom diagnostics.
    Full-sync servers get the plain ``{text}`` form the spec prescribes for them.
    """

    if incremental and previous_end is not None:
        return [
            {
                'range': {'start': {'line': 0, 'character': 0}, 'end': dict(previous_end)},
                'text': text,
            }
        ]
    return [{'text': text}]


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
        # Client currently in ``initialize``; not yet published as ``_client``.
        self._inflight_client: JsonRpcLspClient | None = None
        self._lock = threading.RLock()
        self._diag_cond = threading.Condition(self._lock)
        self._doc_versions: dict[str, int] = {}
        self._diag_generation: dict[str, int] = {}
        self._last_synced_digest: dict[str, bytes] = {}
        # End ``Position`` of the text the server currently holds per document; lets the
        # next didChange replace the exact previous range (see ``_full_replace_content_changes``).
        self._last_synced_end: dict[str, dict[str, int]] = {}
        self._diag_ready_digest: dict[str, bytes] = {}
        # Publishes known to describe the currently synced text (stale in-flight ones excluded).
        self._fresh_diag_generation: dict[str, int] = {}
        self._synced_at: dict[str, float] = {}
        self._doc_origin: dict[str, str] = {}
        # ``(mtime_ns, size)`` of the file when its disk text was last synced; lets disk
        # reconciliation skip unchanged files without reading them.
        self._disk_stat: dict[str, tuple[int, int]] = {}
        # Any publish from the current subprocess yet; a cold server that has published nothing
        # may still be loading the project, so its silence says nothing.
        self._seen_publish = False
        self._path_locks: dict[str, threading.Lock] = {}
        self._sync_epoch: int = 0
        self._bump_sync_epoch_locked()
        self._semantic_tokens_legend: dict[str, list[str]] | None = None
        self._server_capabilities: dict[str, Any] = {}
        self._language_status: str = ''
        self._language_status_message: str = ''
        self._lifecycle_phase: str = 'idle'
        self._lifecycle_error: str = ''

    def should_defer_semantic_tokens_legend_without_document_seed(self) -> bool:
        """True when legend prefetch must not spawn this server before any document seed."""

        return self._plugin.should_defer_semantic_tokens_legend_without_document_seed(self._plugin_state)

    def should_skip_typescript_cold_start_without_seed(self) -> bool:
        """Backward-compatible alias for routes/tests."""

        return self.should_defer_semantic_tokens_legend_without_document_seed()

    def _client_process_alive(self, client: Any) -> bool:
        check = getattr(client, 'is_running', None)
        if callable(check):
            try:
                return bool(check())
            except Exception:
                return False
        # Test doubles without ``is_running`` are treated as alive until cleared.
        return True

    def _forget_dead_client_locked(self) -> None:
        """Drop a dead client object so ``ensure_started`` can spawn a fresh subprocess."""

        client = self._client
        self._client = None
        self._semantic_tokens_legend = None
        self._server_capabilities = {}
        self._language_status = ''
        self._language_status_message = ''
        self._lifecycle_phase = 'crashed'
        if not (self._lifecycle_error or '').strip():
            self._lifecycle_error = 'Language server process exited.'
        self._clear_document_state_locked()
        self._bump_sync_epoch_locked()
        cache = self._diag_cache()
        for rel in list(cache.keys()):
            if lsp_server_for_path(rel) == self.server_kind:
                cache.pop(rel, None)
        if client is None:
            return
        self._close_client_best_effort(
            client,
            session_id=self.session_id,
            server_kind=self.server_kind,
            scope=self.scope,
        )
        logger.warning(
            '%s LSP subprocess died; cleared client for restart session=%s scope=%s',
            self.server_kind,
            self.session_id,
            self.scope,
        )

    _PER_DOCUMENT_STATE = (
        '_doc_versions',
        '_diag_generation',
        '_last_synced_digest',
        '_last_synced_end',
        '_diag_ready_digest',
        '_fresh_diag_generation',
        '_synced_at',
        '_doc_origin',
        '_disk_stat',
    )

    def _clear_document_state_locked(self) -> None:
        for name in self._PER_DOCUMENT_STATE:
            getattr(self, name).clear()
        self._seen_publish = False

    def _forget_document_locked(self, rel: str) -> None:
        for name in self._PER_DOCUMENT_STATE:
            getattr(self, name).pop(rel, None)

    @staticmethod
    def _close_client_best_effort(client: Any, *, session_id: str, server_kind: str, scope: str) -> None:
        closer = getattr(client, 'close', None)
        if not callable(closer):
            return
        try:
            closer()
        except Exception as close_exc:
            logger.debug(
                '%s LSP client close failed session=%s scope=%s err=%s',
                server_kind,
                session_id,
                scope,
                close_exc,
            )

    def ensure_started(self) -> None:
        """Spawn + ``initialize`` the language server if needed.

        Must not hold ``_lock`` during ``initialize``: JDT LS (and others) emit
        ``language/status`` from the stdout reader before the initialize result,
        and that handler needs the same lock. Holding it deadlocks the reader,
        so initialize never completes and Monaco editor fetches time out
        (``fetch failed``).
        """

        client: Any | None = None
        lsp_cwd: Path | None = None
        init_opts: dict[str, Any] = {}
        while True:
            with self._lock:
                if self._client is not None and not self._client_process_alive(self._client):
                    self._forget_dead_client_locked()
                if self._client is not None:
                    return
                if self._lifecycle_phase == 'shuttingDown':
                    raise RuntimeError(f'{self.server_kind} LSP client is shutting down.')
                if self._lifecycle_phase in {'starting', 'initializing'}:
                    self._diag_cond.wait(timeout=0.5)
                    continue
                self._lifecycle_phase = 'starting'
                self._lifecycle_error = ''
                try:
                    bundle = self._plugin.compute_start_params(
                        session=self.session,
                        workspace_root=self.workspace_root,
                        state=self._plugin_state,
                        session_id=self.session_id,
                        scope=self.scope,
                    )
                except Exception:
                    self._lifecycle_phase = 'crashed'
                    self._lifecycle_error = 'Failed to resolve language-server command.'
                    self._diag_cond.notify_all()
                    raise
                lsp_cwd = bundle.lsp_cwd
                command = bundle.command
                init_opts = dict(bundle.init_options or {})
                spawn_env = bundle.env
                startup_timeout_s = bundle.startup_timeout_s
                factory = self._client_factory or (
                    lambda *, command, workspace_root, notification_handler, env=None: JsonRpcLspClient(
                        command,
                        workspace_root=workspace_root,
                        notification_handler=notification_handler,
                        env=env,
                        startup_timeout_s=startup_timeout_s or 20.0,
                    )
                )
                try:
                    client = factory(
                        command=command,
                        workspace_root=lsp_cwd,
                        notification_handler=self._handle_notification,
                        env=spawn_env,
                    )
                except Exception:
                    self._lifecycle_phase = 'crashed'
                    self._lifecycle_error = 'Failed to spawn language-server subprocess.'
                    self._diag_cond.notify_all()
                    raise
                self._inflight_client = client
                self._lifecycle_phase = 'initializing'
                self._diag_cond.notify_all()
            break

        assert client is not None and lsp_cwd is not None
        try:
            init_result = client.initialize(
                root_uri=_path_to_uri(lsp_cwd),
                process_id=os.getpid(),
                capabilities=_workspace_capabilities(),
                initialization_options=init_opts,
            )
        except Exception as exc:
            with self._lock:
                if self._inflight_client is client:
                    self._inflight_client = None
                already_shutting = self._lifecycle_phase == 'shuttingDown'
                if not already_shutting:
                    self._lifecycle_phase = 'crashed'
                    self._lifecycle_error = str(exc).strip()[:400]
                    self._close_client_best_effort(
                        client,
                        session_id=self.session_id,
                        server_kind=self.server_kind,
                        scope=self.scope,
                    )
                self._diag_cond.notify_all()
            if not already_shutting:
                logger.warning(
                    '%s LSP initialize failed; subprocess closed session=%s scope=%s',
                    self.server_kind,
                    self.session_id,
                    self.scope,
                )
            raise
        with self._lock:
            if self._inflight_client is client:
                self._inflight_client = None
            if self._lifecycle_phase == 'shuttingDown':
                self._close_client_best_effort(
                    client,
                    session_id=self.session_id,
                    server_kind=self.server_kind,
                    scope=self.scope,
                )
                self._diag_cond.notify_all()
                raise RuntimeError(f'{self.server_kind} LSP client is shutting down.')
            self._semantic_tokens_legend = _extract_semantic_tokens_legend(init_result)
            caps = init_result.get('capabilities') if isinstance(init_result, dict) else None
            self._server_capabilities = caps if isinstance(caps, dict) else {}
            self._client = client
            self._set_running_or_indexing_locked()
            self._plugin.on_after_client_started(
                session=self.session,
                workspace_root=self.workspace_root,
                state=self._plugin_state,
                lsp_cwd=lsp_cwd,
            )
            self.session.lsp.lsp_workspace_root = str(self.workspace_root)
            self._diag_cond.notify_all()
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
            self._lifecycle_phase = 'shuttingDown'
            client = self._client
            inflight = self._inflight_client
            self._client = None
            self._inflight_client = None
            self._semantic_tokens_legend = None
            self._server_capabilities = {}
            self._language_status = ''
            self._language_status_message = ''
            self._clear_document_state_locked()
            self._bump_sync_epoch_locked()
            cache = self._diag_cache()
            for rel in list(cache.keys()):
                if lsp_server_for_path(rel) == self.server_kind:
                    cache.pop(rel, None)
            self._diag_cond.notify_all()
        if inflight is not None and inflight is not client:
            self._close_client_best_effort(
                inflight,
                session_id=self.session_id,
                server_kind=self.server_kind,
                scope=self.scope,
            )
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
        origin: str = DOC_ORIGIN_DISK,
        disk_stat: tuple[int, int] | None = None,
    ) -> list[dict[str, Any]]:
        """Open or update one document with ``text``.

        ``origin`` records who supplied the text: editor routes pass ``DOC_ORIGIN_EDITOR`` (the
        buffer may be unsaved); everything else is disk content. ``disk_stat`` is the file's
        ``(mtime_ns, size)`` when ``text`` was just read from it.
        """
        rel = normalize_relative_posix_path(relative_path)
        policy = self._policy(rel)
        if policy is None:
            raise ValueError(f'LSP sync is not supported for `{rel}` on {self.server_kind} server.')
        digest = hashlib.sha256(text.encode('utf-8')).digest()
        with self._lock:
            running = self._client is not None and self._client_process_alive(self._client)
        if self._plugin.on_before_sync_document(
            session=self.session,
            workspace_root=self.workspace_root,
            relative_posix_path=rel,
            state=self._plugin_state,
            client_running=running,
            text=text,
        ):
            self._restart_in_place()
        self.ensure_started()
        self._push_pending_configuration()
        with self._path_lock_for(rel):
            return self._sync_document_locked(
                rel,
                text,
                digest=digest,
                policy=policy,
                wait_for_diagnostics=wait_for_diagnostics,
                origin=origin,
                disk_stat=disk_stat,
            )

    def _restart_in_place(self) -> None:
        """Stop the server so the next ``ensure_started`` spawns a fresh one for this same manager.

        ``shutdown`` leaves the phase at ``shuttingDown`` because it normally ends a manager's
        life; ``ensure_started`` refuses that phase, so a plugin-requested restart (new project
        root or Java build file) must clear it or every later request fails until app restart.
        """

        active_scope = self.session.lsp.lsp_active_scope
        self.shutdown()
        self.session.lsp.lsp_active_scope = active_scope
        with self._lock:
            if self._lifecycle_phase == 'shuttingDown':
                self._lifecycle_phase = 'idle'
                self._lifecycle_error = ''
            self._diag_cond.notify_all()
        logger.info(
            '%s LSP restarting for plugin request session=%s scope=%s',
            self.server_kind,
            self.session_id,
            self.scope,
        )

    def _push_pending_configuration(self) -> None:
        """Send settings the plugin changed since start (e.g. Java loose-folder source paths)."""

        options = self._plugin.take_pending_initialization_options(self._plugin_state)
        if options is None:
            return
        with self._lock:
            client = self._client
        updater = getattr(client, 'update_configuration', None)
        if not callable(updater):
            return
        try:
            updater(options)
            logger.info(
                '%s LSP configuration updated session=%s scope=%s',
                self.server_kind,
                self.session_id,
                self.scope,
            )
        except Exception as exc:
            logger.warning(
                '%s LSP configuration update failed session=%s scope=%s err=%s',
                self.server_kind,
                self.session_id,
                self.scope,
                exc,
            )

    def _path_lock_for(self, rel: str) -> threading.Lock:
        with self._lock:
            lock = self._path_locks.get(rel)
            if lock is None:
                lock = threading.Lock()
                self._path_locks[rel] = lock
            return lock

    def _sync_document_locked(
        self,
        rel: str,
        text: str,
        *,
        digest: bytes,
        policy: Any,
        wait_for_diagnostics: bool,
        origin: str = DOC_ORIGIN_DISK,
        disk_stat: tuple[int, int] | None = None,
    ) -> list[dict[str, Any]]:
        path = normalize_relative_path(self.workspace_root, rel)
        uri = _path_to_uri(path)
        with self._lock:
            cache = self._diag_cache()
            same_digest = rel in self._doc_versions and self._last_synced_digest.get(rel) == digest
            ready = self._diag_ready_digest.get(rel) == digest
            if same_digest:
                # Identical text: the editor confirming its buffer takes ownership back; a disk
                # read leaves an editor-owned (clean) buffer with the editor.
                if origin == DOC_ORIGIN_EDITOR:
                    self._doc_origin[rel] = DOC_ORIGIN_EDITOR
                if disk_stat is not None:
                    self._disk_stat[rel] = disk_stat
                # The editor follows later publishes through its diagnostics watch, so unchanged
                # editor text never waits or re-sends (the waits below are for agent callers).
                if ready or not wait_for_diagnostics or origin == DOC_ORIGIN_EDITOR:
                    return list(cache.get(rel, []))
                # Synced recently without a wait (editor hover/completion): the publish for this
                # text is still on its way, so wait for it instead of re-sending the same text.
                # Once that window has passed, fall through and re-send to prompt a new publish.
                pending_s = self._diag_wait_timeout_s(first_open=self._doc_versions.get(rel) == 1) - (
                    time.monotonic() - self._synced_at.get(rel, 0.0)
                )
                if pending_s > 0:
                    published = self._wait_for_diagnostics(
                        rel, self._fresh_diag_generation.get(rel, 0), timeout_s=pending_s
                    )
                    if self._wait_settled(published):
                        self._diag_ready_digest[rel] = digest
                    return list(cache.get(rel, []))
            # Resolve the client before bumping the version: if it is gone, a bumped version would
            # make the next sync send ``didChange`` for a document the new server never opened.
            client = self._require_client()
            prev_fresh_generation = self._fresh_diag_generation.get(rel, 0)
            version = self._doc_versions.get(rel, 0) + 1
            previous_end = self._last_synced_end.get(rel)
            # Record what the server is about to hold before notifying: a fast publish handled on
            # the reader thread checks freshness against this state.
            self._doc_versions[rel] = version
            self._last_synced_digest[rel] = digest
            self._last_synced_end[rel] = _lsp_document_end_position(text)
            self._synced_at[rel] = time.monotonic()
            self._doc_origin[rel] = origin
            if disk_stat is not None:
                self._disk_stat[rel] = disk_stat
            else:
                # Text not read from disk here (editor buffer, or an edit tool's write): the next
                # disk reconciliation must read the file once to compare.
                self._disk_stat.pop(rel, None)
            self._diag_ready_digest.pop(rel, None)
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
                        'contentChanges': _full_replace_content_changes(
                            text,
                            previous_end=previous_end,
                            incremental=_server_uses_incremental_sync(self._server_capabilities),
                        ),
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
                # Open documents importing this one get re-checked; their cached diagnostics are
                # outdated until the server republishes them. (A re-send of identical text, to
                # prompt a missing publish, changes nothing for them.)
                if not same_digest:
                    self._expect_republish_except([rel])
            if wait_for_diagnostics:
                published = self._wait_for_diagnostics(rel, prev_fresh_generation, first_open=version == 1)
                if self._wait_settled(published):
                    self._diag_ready_digest[rel] = digest
            rows = list(cache.get(rel, []))
        if self.scope == 'staging':
            try:
                pending = [
                    peer
                    for peer in _pending_unapplied_staging_rels(self.session)
                    if lsp_server_for_path(peer) == self.server_kind and peer != rel
                ]
                self.notify_watched_file_changes(pending)
            except Exception as exc:
                logger.debug(
                    '%s staging watched-files notify failed session=%s err=%s',
                    self.server_kind,
                    self.session_id,
                    exc,
                )
        return rows

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
        stat = _disk_stat_of(target)
        text = read_file_for_tools(target, enc)
        return self.sync_document(rel, text, wait_for_diagnostics=wait_for_diagnostics, disk_stat=stat)

    def sync_for_agent(
        self,
        relative_path: str,
        *,
        encoding: str = 'utf-8',
        wait_for_diagnostics: bool = False,
    ) -> list[dict[str, Any]]:
        """Bring the server in line with disk before an agent query on ``relative_path``.

        The agent reads files from disk and passes disk line numbers, so the queried document
        is synced from disk even when the editor holds an unsaved buffer for it (the editor
        re-sends its buffer on its next request; see ``document_synced_by_editor``). Other open
        documents the editor does not own are refreshed when their file changed, so cross-file
        results do not come from text that ``run_command`` / git / the copy tool replaced.
        """

        rel = normalize_relative_posix_path(relative_path)
        self.reconcile_disk_documents(encoding=encoding, skip=frozenset({rel}))
        return self.sync_workspace_document(rel, encoding=encoding, wait_for_diagnostics=wait_for_diagnostics)

    def _expect_republish_except(self, changed: list[str]) -> None:
        """Files changed under the server: open documents' cached diagnostics may be outdated.

        The server re-checks open dependents and republishes them for their unchanged version,
        so the next waiting sync of any other open document waits for that publish instead of
        returning the old cache (and re-sends its text if none arrives in the wait window).
        """

        if not changed:
            return
        now = time.monotonic()
        with self._lock:
            for rel in self._doc_versions:
                if rel not in changed:
                    self._diag_ready_digest.pop(rel, None)
                    self._synced_at[rel] = now

    def reconcile_disk_documents(self, *, encoding: str = 'utf-8', skip: frozenset[str] = frozenset()) -> list[str]:
        """Re-sync open disk-owned documents whose file changed; close those whose file is gone.

        Cheap when nothing changed: one ``stat`` per open document. Editor-owned documents are
        left alone (the editor reloads clean buffers itself and keeps dirty ones on purpose).
        Never starts a server. Returns the paths whose server-side text changed or was closed.
        """

        if not self.is_client_running():
            return []
        changed: list[str] = []
        with self._lock:
            candidates = [
                (rel, self._disk_stat.get(rel))
                for rel in self._doc_versions
                if rel not in skip and self._doc_origin.get(rel) != DOC_ORIGIN_EDITOR
            ]
        deleted: list[str] = []
        for rel, known_stat in candidates:
            try:
                target = normalize_relative_path(self.workspace_root, rel)
            except Exception:
                continue
            stat = _disk_stat_of(target)
            if stat is None:
                self.close_document(rel)
                deleted.append(rel)
                continue
            if stat == known_stat:
                continue
            version = self.document_version(rel)
            try:
                self.sync_workspace_document(rel, encoding=encoding, wait_for_diagnostics=False)
            except Exception as exc:
                logger.debug(
                    '%s disk reconcile skipped session=%s path=%s err=%s',
                    self.server_kind,
                    self.session_id,
                    rel,
                    exc,
                )
                continue
            if self.document_version(rel) != version:
                changed.append(rel)
        if deleted:
            self.notify_watched_file_changes(deleted, change_type=3)
            self._expect_republish_except(deleted)
        return changed + deleted

    def apply_disk_changes(self, changes: list[tuple[str, str]], *, encoding: str = 'utf-8') -> None:
        """React to a workspace watcher batch of ``(relative_path, kind)`` pairs.

        Open disk-owned documents are re-synced (or closed when deleted); files the server
        does not have open are reported with ``workspace/didChangeWatchedFiles`` so it re-reads
        them (basedpyright does not watch the file system itself). Never starts a server.
        """

        if not self.is_client_running():
            return
        if any(path in ('', '.') for path, _kind in changes):
            self.reconcile_disk_documents(encoding=encoding)
            return
        watched: dict[int, list[str]] = {}
        for raw_path, kind in changes:
            if raw_path.startswith('[staging] '):
                continue
            rel = normalize_relative_posix_path(raw_path)
            if not rel or lsp_server_for_path(rel) != self.server_kind:
                continue
            with self._lock:
                tracked = rel in self._doc_versions
                origin = self._doc_origin.get(rel)
            if tracked and origin == DOC_ORIGIN_EDITOR:
                continue
            if tracked:
                try:
                    target = normalize_relative_path(self.workspace_root, rel)
                except Exception:
                    continue
                if kind == 'deleted' or _disk_stat_of(target) is None:
                    self.close_document(rel)
                    watched.setdefault(3, []).append(rel)
                    continue
                try:
                    self.sync_workspace_document(rel, encoding=encoding, wait_for_diagnostics=False)
                except Exception as exc:
                    logger.debug(
                        '%s watcher resync skipped session=%s path=%s err=%s',
                        self.server_kind,
                        self.session_id,
                        rel,
                        exc,
                    )
                continue
            watched.setdefault(_WATCHED_FILE_CHANGE_TYPES.get(kind, 2), []).append(rel)
        for change_type, rels in watched.items():
            self.notify_watched_file_changes(rels, change_type=change_type)
        # Re-synced documents flagged their dependents already (``didChange``); files the server
        # only hears about through the watched-files event need the same.
        self._expect_republish_except([rel for rels in watched.values() for rel in rels])

    def document_synced_by_editor(self, relative_path: str) -> bool:
        """True when the server holds text the Monaco editor sent (so the editor may skip re-sending)."""

        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            return rel in self._doc_versions and self._doc_origin.get(rel) == DOC_ORIGIN_EDITOR

    def diagnostics_fresh(self, relative_path: str) -> bool:
        """True when the cached diagnostics were published for the text the server now holds."""

        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            digest = self._last_synced_digest.get(rel)
            return digest is not None and self._diag_ready_digest.get(rel) == digest

    def mark_diagnostics_stale(self, relative_path: str) -> None:
        """Make the next waiting sync re-send the document and wait for a new publish."""

        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            self._diag_ready_digest.pop(rel, None)
            self._synced_at.pop(rel, None)

    def document_version(self, relative_path: str) -> int:
        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            return int(self._doc_versions.get(rel, 0))

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
            # Keep the generation counter: the editor's diagnostics watch treats a counter that
            # goes backwards as a server reset.
            generation = self._diag_generation.get(rel)
            self._forget_document_locked(rel)
            if generation is not None:
                self._diag_generation[rel] = generation
            cache.pop(rel, None)
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

    def document_is_tracked(self, relative_path: str) -> bool:
        rel = normalize_relative_posix_path(relative_path)
        with self._lock:
            return rel in self._doc_versions

    def tracked_relative_paths(self) -> list[str]:
        with self._lock:
            return list(self._doc_versions.keys())

    def _bump_sync_epoch_locked(self) -> None:
        """Advance this manager's epoch and the session-level counter (survives recreate)."""

        self._sync_epoch += 1
        lsp = getattr(self.session, 'lsp', None)
        if lsp is not None:
            lsp.lsp_sync_epoch = int(getattr(lsp, 'lsp_sync_epoch', 0) or 0) + 1

    def get_sync_epoch(self) -> int:
        lsp = getattr(self.session, 'lsp', None)
        if lsp is not None:
            return int(getattr(lsp, 'lsp_sync_epoch', 0) or 0)
        return int(self._sync_epoch)

    def resync_tracked_documents_from_disk(self, *, encoding: str = 'utf-8') -> None:
        """Re-read overlay/workspace files for every open document (digest-skips unchanged)."""

        for rel in self.tracked_relative_paths():
            try:
                self.sync_workspace_document(rel, encoding=encoding, wait_for_diagnostics=False)
            except Exception as exc:
                logger.debug(
                    '%s overlay resync skipped session=%s scope=%s path=%s err=%s',
                    self.server_kind,
                    self.session_id,
                    self.scope,
                    rel,
                    exc,
                )

    def notify_watched_file_changes(self, relative_paths: list[str], *, change_type: int = 2) -> None:
        """Tell the language server overlay/disk peers changed (Created=1, Changed=2, Deleted=3)."""

        rels = [normalize_relative_posix_path(p) for p in relative_paths if str(p).strip()]
        if not rels:
            return
        try:
            client = self._require_client()
        except RuntimeError:
            return
        changes: list[dict[str, Any]] = []
        for rel in rels:
            try:
                uri = _path_to_uri(normalize_relative_path(self.workspace_root, rel))
            except Exception:
                continue
            changes.append({'uri': uri, 'type': int(change_type)})
        if not changes:
            return
        client.notify('workspace/didChangeWatchedFiles', {'changes': changes})

    def save_document(self, relative_path: str) -> None:
        rel = normalize_relative_posix_path(relative_path)
        if self._policy(rel) is None:
            return
        with self._lock:
            if rel not in self._doc_versions:
                return
            client = self._client
            if client is None:
                return
            target = normalize_relative_path(self.workspace_root, rel)
        client.notify('textDocument/didSave', {'textDocument': {'uri': _path_to_uri(target)}})

    def hover(self, relative_path: str, line: int, character: int) -> dict[str, Any]:
        rel = self._ensure_workspace_synced(relative_path)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
        }
        return self._require_client().request('textDocument/hover', params, timeout_s=8.0)

    def hover_for_editor(
        self,
        relative_path: str,
        line: int,
        character: int,
    ) -> tuple[dict[str, Any], bool]:
        """Like ``hover`` but reports whether the buffer had to be synced from disk.

        Returns ``(result, synced_from_disk)``. ``synced_from_disk`` is True when the server does
        not hold the editor's text: the document was not tracked (e.g. after a TS project-root
        restart cleared ``_doc_versions``) and was read from disk here, or an agent tool / disk
        change replaced the editor's buffer since. The editor uses this signal to re-send the
        buffer and re-request so hover reflects the editor.
        """

        rel = normalize_relative_posix_path(relative_path)
        if self._policy(rel) is None:
            raise ValueError(f'LSP tools do not support `{rel}` on the {self.server_kind} server.')
        with self._lock:
            tracked = rel in self._doc_versions
        synced_from_disk = not self.document_synced_by_editor(rel)
        if tracked:
            self.ensure_started()
        else:
            self.sync_workspace_document(rel)
        params = {
            'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))},
            'position': {'line': max(0, int(line) - 1), 'character': max(0, int(character) - 1)},
        }
        result = self._require_client().request('textDocument/hover', params, timeout_s=8.0)
        if not isinstance(result, dict):
            result = {'contents': result}
        return result, synced_from_disk

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
        self._wait_for_java_workspace_ready()
        timeout_s = 25.0 if self.server_kind == 'java' else 15.0
        return self._require_client().request('textDocument/completion', params, timeout_s=timeout_s)

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
        if not self._has_provider('codeLensProvider'):
            return []
        params = {'textDocument': {'uri': _path_to_uri(normalize_relative_path(self.workspace_root, rel))}}
        return self._require_client().request('textDocument/codeLens', params, timeout_s=15.0)

    def code_lens_resolve(self, code_lens: dict[str, Any]) -> Any:
        from clara_coder_backend.lsp.editor_monaco import monaco_code_lens_to_lsp

        lsp_lens = monaco_code_lens_to_lsp(code_lens)
        if lsp_lens is None:
            raise ValueError('Invalid code lens payload for resolve.')
        # JDT LS NPEs when ``data`` is null (CodeLensHandler.resolve). Skip the
        # round-trip when there is nothing server-side to resolve.
        if lsp_lens.get('data') is None:
            return lsp_lens
        self.ensure_started()
        if not self._has_provider('codeLensProvider'):
            return lsp_lens
        return self._require_client().request('codeLens/resolve', lsp_lens, timeout_s=8.0)

    @property
    def semantic_tokens_legend(self) -> dict[str, list[str]] | None:
        return self._semantic_tokens_legend

    def _has_provider(self, capability_name: str) -> bool:
        """True when initialize advertised this provider (bool or options object)."""

        val = self._server_capabilities.get(capability_name)
        return val is True or isinstance(val, dict)

    def _policy(self, rel: str) -> Any:
        policy = get_lsp_file_policy(rel)
        if policy is None or policy.lsp_server != self.server_kind:
            return None
        return policy

    def _ensure_workspace_synced(self, relative_path: str) -> str:
        rel = normalize_relative_posix_path(relative_path)
        if self._policy(rel) is None:
            raise ValueError(f'LSP tools do not support `{rel}` on the {self.server_kind} server.')
        # Keep an already-open buffer (editor unsaved text). Only read disk when
        # the language server has no document for this path.
        with self._lock:
            tracked = rel in self._doc_versions
        if tracked:
            self.ensure_started()
        else:
            self.sync_workspace_document(rel)
        return rel

    def _wait_for_java_workspace_ready(self, timeout_s: float = _JAVA_WAIT_READY_TIMEOUT_S) -> None:
        """Block briefly until JDT LS reports a usable workspace.

        Completions before project import return an empty list. Custom
        ``CLARA_JAVA_LSP_COMMAND`` servers that never send ``language/status``
        proceed after 3s so IntelliSense is not stuck. ``Starting`` is not
        treated as ready, but we do not hold the HTTP worker for a full minute.
        """

        if self.server_kind != 'java':
            return
        deadline = time.monotonic() + max(1.0, float(timeout_s))
        no_status_deadline = time.monotonic() + _JAVA_NO_STATUS_GRACE_S
        starting_deadline = time.monotonic() + _JAVA_STARTING_GRACE_S
        with self._lock:
            while True:
                st = (self._language_status or '').strip()
                msg = (self._language_status_message or '').strip()
                if java_workspace_is_ready(st, msg):
                    return
                now = time.monotonic()
                if now >= deadline:
                    logger.warning(
                        'java LSP workspace not Ready after %.1fs (status=%s message=%s) session=%s',
                        timeout_s,
                        self._language_status or '(none)',
                        self._language_status_message or '(none)',
                        self.session_id,
                    )
                    return
                if not st and now >= no_status_deadline:
                    return
                if st and now >= starting_deadline:
                    return
                wait_for = min(0.4, deadline - now)
                if not st:
                    wait_for = min(wait_for, no_status_deadline - now)
                else:
                    wait_for = min(wait_for, starting_deadline - now)
                if wait_for <= 0:
                    continue
                self._diag_cond.wait(timeout=wait_for)

    def _handle_notification(self, method: str, params: dict[str, Any]) -> None:
        if method == 'language/status':
            status_type = str(params.get('type') or params.get('Status') or '')
            message = str(params.get('message') or '')
            with self._lock:
                self._language_status = status_type
                self._language_status_message = message
                if (
                    self.server_kind == 'java'
                    and self._lifecycle_phase not in {'idle', 'shuttingDown', 'crashed', 'starting'}
                    and java_workspace_is_ready(status_type, message)
                ):
                    self._lifecycle_phase = 'running'
                self._diag_cond.notify_all()
            logger.info(
                '%s LSP language/status session=%s scope=%s type=%s message=%s',
                self.server_kind,
                self.session_id,
                self.scope,
                status_type,
                message,
            )
            return
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
        version = params.get('version')
        with self._lock:
            current = self._doc_versions.get(rel)
            if isinstance(version, int) and current is not None and version < current:
                # Computed for text we have since replaced (it was in flight when we sent the
                # change). Its ranges point into the old text; the publish for ``current`` follows.
                logger.debug(
                    '%s dropped stale diagnostics session=%s path=%s version=%s current=%s',
                    self.server_kind,
                    self.session_id,
                    rel,
                    version,
                    current,
                )
                return
            self._seen_publish = True
            self._diag_cache()[rel] = normalized
            self._diag_generation[rel] = self._diag_generation.get(rel, 0) + 1
            if current is not None and (
                isinstance(version, int)
                or time.monotonic() - self._synced_at.get(rel, 0.0) >= self._plugin.unversioned_publish_min_delay_s
            ):
                self._fresh_diag_generation[rel] = self._fresh_diag_generation.get(rel, 0) + 1
                digest = self._last_synced_digest.get(rel)
                if digest is not None:
                    self._diag_ready_digest[rel] = digest
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

    def _diag_wait_timeout_s(self, *, first_open: bool) -> float:
        slow = self._plugin.slow_diagnostics
        # A server that stays silent for clean files would make every clean first open wait the
        # whole cold-start window; it gets the regular window (see ``_wait_settled``).
        if first_open and not self._plugin.silent_when_diagnostics_unchanged:
            return _DIAG_FIRST_OPEN_TIMEOUT_SLOW_S if slow else _DIAG_FIRST_OPEN_TIMEOUT_S
        return _DIAG_WAIT_TIMEOUT_SLOW_S if slow else _DIAG_WAIT_TIMEOUT_S

    def _wait_settled(self, published: bool) -> bool:
        """Whether a finished diagnostics wait leaves the cache describing the synced text.

        True after a fresh publish. A server that only publishes on change (vtsls) stays silent
        when the file's diagnostics did not change, so silence through the window also settles
        it, once that server has published anything at all (before that it may still be loading).
        """

        if published:
            return True
        return self._plugin.silent_when_diagnostics_unchanged and self._seen_publish

    def _wait_for_diagnostics(
        self,
        relative_path: str,
        previous_generation: int,
        *,
        first_open: bool = False,
        timeout_s: float | None = None,
    ) -> bool:
        """Wait until a fresh publish arrives (see ``_handle_notification``), then a short quiet window.

        Returns True when at least one fresh publish arrived (and the quiet window elapsed or
        the deadline was reached after an advance). False means the wait timed out with
        no fresh publish — callers must not treat the digest as fresh.
        """

        if timeout_s is None:
            timeout_s = self._diag_wait_timeout_s(first_open=first_open)
        deadline = time.monotonic() + timeout_s
        last_seen = previous_generation
        quiet_until: float | None = None
        while True:
            now = time.monotonic()
            if now >= deadline:
                return last_seen > previous_generation
            with self._lock:
                gen = int(self._fresh_diag_generation.get(relative_path, 0))
                if gen > last_seen:
                    last_seen = gen
                    quiet_until = time.monotonic() + _DIAG_QUIET_S
                if last_seen > previous_generation and quiet_until is not None:
                    remaining_quiet = quiet_until - time.monotonic()
                    if remaining_quiet <= 0:
                        return True
                    wait_for = min(remaining_quiet, deadline - time.monotonic(), 0.2)
                else:
                    wait_for = min(0.2, deadline - now)
                if wait_for <= 0:
                    continue
                self._diag_cond.wait(timeout=max(0.01, wait_for))

    def _require_client(self) -> JsonRpcLspClient:
        with self._lock:
            if self._client is not None and not self._client_process_alive(self._client):
                self._forget_dead_client_locked()
            if self._client is None:
                raise RuntimeError(f'{self.server_kind} LSP client is not initialized.')
            return self._client

    def is_client_running(self) -> bool:
        """True when this manager holds a live language-server subprocess (read-only)."""

        client = self._client
        if client is None:
            return False
        return self._client_process_alive(client)

    def lifecycle_phase(self) -> str:
        """Current subprocess lifecycle phase (read-only; lock-free like ``is_client_running``)."""

        return self._lifecycle_phase

    def _set_running_or_indexing_locked(self) -> None:
        if self.server_kind == 'java' and not java_workspace_is_ready(
            self._language_status, self._language_status_message
        ):
            self._lifecycle_phase = 'indexing'
            return
        self._lifecycle_phase = 'running'

    def dashboard_entry(self) -> dict[str, Any]:
        """Status payload for ``GET /lsp/status`` without starting a subprocess."""

        running = self.is_client_running()
        phase = self._lifecycle_phase
        if phase != 'shuttingDown' and self._client is not None and not running:
            phase = 'crashed'
        st = (self._language_status or '').strip()
        msg = (self._language_status_message or '').strip()
        language_status = ''
        if st and msg:
            language_status = f'{st}: {msg}'
        elif st or msg:
            language_status = st or msg
        entry: dict[str, Any] = {
            'initialized': running,
            'phase': phase,
            'scope': self.scope,
        }
        if language_status:
            entry['languageStatus'] = language_status
        err = (self._lifecycle_error or '').strip()
        if phase == 'crashed' and not err:
            err = 'Language server process exited.'
        if err and phase == 'crashed':
            entry['lastError'] = err
        return entry


PythonLspManager = SessionWorkspaceLspManager


def lsp_owner_session_id(session_id: str) -> str:
    """Session whose language servers serve ``session_id``: a sub-agent uses its parent's.

    A sub-agent shares the parent's workspace and ``lsp`` state, so keying its managers by the parent
    means no second set of language-server processes starts per sub-agent.
    """
    sess = sessions.get(session_id)
    parent = (getattr(sess, 'subagent_parent_session_id', '') or '').strip() if sess is not None else ''
    return parent or session_id


def _resolve_session_and_root(session_id: str | None) -> tuple[str, SessionState, Path]:
    sid = (session_id or current_session_id.get() or '').strip()
    if not sid:
        raise ValueError('No active session is available for LSP.')
    sid = lsp_owner_session_id(sid)
    session = get_session(sid)
    if not session.workspace_path:
        raise ValueError('This conversation does not have a workspace attached.')
    return sid, session, Path(session.workspace_path).resolve()


def _effective_lsp_workspace_root(session: SessionState, scope: str, *, session_id: str) -> Path:
    del scope, session_id
    return Path(session.workspace.workspace_path).resolve()


def activate_session_lsp_scope(session_id: str | None = None, *, scope: str) -> None:
    """Set the session's default LSP scope without tearing down the other scope's managers."""

    _sid, session, _workspace_root = _resolve_session_and_root(session_id)
    session.lsp.lsp_active_scope = _normalize_lsp_scope(scope)


def _pending_unapplied_staging_rels(session: SessionState) -> list[str]:
    pending = getattr(session, 'pending_edit_stagings', None)
    if not isinstance(pending, dict):
        return []
    out: list[str] = []
    for rel_key, entry in pending.items():
        if getattr(entry, 'workspace_applied', False):
            continue
        rel = str(rel_key).strip().replace('\\', '/')
        if rel and '..' not in rel.split('/'):
            out.append(rel)
    return out


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
    stale: SessionWorkspaceLspManager | None = None
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.get(key)
        if manager is not None and manager.workspace_root != effective_root:
            popped = _SESSION_MANAGERS.pop(key, None)
            if popped is manager:
                stale = manager
            manager = None
    if stale is not None:
        stale.shutdown()
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.get(key)
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


def _shutdown_and_forget_managers(
    pairs: list[tuple[tuple[str, str, str], SessionWorkspaceLspManager]],
) -> None:
    """Shut down managers while they remain visible, then drop each map entry."""

    for key, manager in pairs:
        manager.shutdown()
        with _MANAGERS_LOCK:
            if _SESSION_MANAGERS.get(key) is manager:
                _SESSION_MANAGERS.pop(key, None)


def shutdown_session_lsp_server(session_id: str, server_id: str) -> None:
    """Stop language-server managers for one server id on this session (all scopes)."""

    sid = (session_id or '').strip()
    if not sid:
        return
    srv = (server_id or '').strip()
    with _MANAGERS_LOCK:
        pairs = [(k, mgr) for k, mgr in _SESSION_MANAGERS.items() if k[0] == sid and k[1] == srv]
    _shutdown_and_forget_managers(pairs)


def shutdown_session_python_lsp(session_id: str) -> None:
    """Stop only the Python language-server manager for this session (e.g. after interpreter change)."""

    shutdown_session_lsp_server(session_id, 'python')


def shutdown_session_lsp_scope(session_id: str, scope: str) -> None:
    """Stop managers for one LSP scope without tearing down the other scope."""

    sid = (session_id or '').strip()
    if not sid:
        return
    desired = _normalize_lsp_scope(scope)
    with _MANAGERS_LOCK:
        pairs = [(k, mgr) for k, mgr in _SESSION_MANAGERS.items() if k[0] == sid and k[2] == desired]
    _shutdown_and_forget_managers(pairs)
    try:
        session = get_session(sid)
        clear_diagnostics_caches(session, scope=desired)
        if desired == 'staging':
            clear_lsp_staging_overlay(session)
            if session.lsp.lsp_active_scope == 'staging':
                session.lsp.lsp_active_scope = 'workspace'
    except Exception as exc:
        logger.warning('clear LSP scope=%s overlay failed session=%s err=%s', desired, sid, exc)


def shutdown_session_lsp(session_id: str) -> None:
    with _MANAGERS_LOCK:
        pairs = [(k, mgr) for k, mgr in _SESSION_MANAGERS.items() if k[0] == session_id]
    _shutdown_and_forget_managers(pairs)
    try:
        session = get_session(session_id)
        clear_diagnostics_caches(session)
        clear_lsp_staging_overlay(session)
    except Exception as exc:
        logger.warning('clear LSP staging overlay failed session=%s err=%s', session_id, exc)


def shutdown_all_lsp_managers() -> None:
    with _MANAGERS_LOCK:
        pairs = list(_SESSION_MANAGERS.items())
    _shutdown_and_forget_managers(pairs)
    cleared_sessions: set[str] = set()
    for _key, manager in pairs:
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
        servers_payload: dict[str, dict[str, Any]] = {}
        for srv_id in iter_registered_lsp_server_ids():
            best: dict[str, Any] | None = None
            best_rank = -1
            for k, mgr in _SESSION_MANAGERS.items():
                if k[0] != sid or k[1] != srv_id:
                    continue
                entry = mgr.dashboard_entry()
                rank = _LIFECYCLE_PHASE_RANK.get(str(entry.get('phase') or 'idle'), 0)
                if rank > best_rank:
                    best = entry
                    best_rank = rank
            if best is None:
                servers_payload[srv_id] = {'initialized': False, 'phase': 'idle'}
            else:
                payload: dict[str, Any] = {
                    'initialized': bool(best.get('initialized')),
                    'phase': str(best.get('phase') or 'idle'),
                }
                lang = str(best.get('languageStatus') or '').strip()
                if lang:
                    payload['languageStatus'] = lang
                scope = str(best.get('scope') or '').strip()
                if scope:
                    payload['scope'] = scope
                last_err = str(best.get('lastError') or '').strip()
                if last_err:
                    payload['lastError'] = last_err
                servers_payload[srv_id] = payload
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
    py_env_path = python_environment_path_for_workspace(session, workspace_root)
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
    reconcile_disk: bool = False,
    encoding: str = 'utf-8',
) -> list[dict[str, Any]]:
    """Sync ``text`` (already written to disk by the caller) and return its diagnostics.

    ``reconcile_disk`` first refreshes other open documents whose files changed on disk, so the
    diagnostics are computed against current imports rather than text replaced by a shell command.
    """

    sid = (session_id or current_session_id.get() or '').strip() or None
    if sid is not None:
        sid = lsp_owner_session_id(sid)
    server = lsp_server_for_path(relative_path)
    if not server:
        raise ValueError(f'No LSP server is configured for `{relative_path}`.')

    def _sync(manager: SessionWorkspaceLspManager) -> list[dict[str, Any]]:
        if reconcile_disk:
            manager.reconcile_disk_documents(
                encoding=encoding, skip=frozenset({normalize_relative_posix_path(relative_path)})
            )
        return manager.sync_document(relative_path, text, wait_for_diagnostics=wait_for_diagnostics)

    try:
        return _sync(get_session_lsp_manager(sid, scope=scope, server=server))
    except Exception as exc:
        if sid is None or not _should_retry_lsp_bootstrap(exc):
            raise
        logger.warning('retrying LSP sync after bootstrap failure session=%s server=%s err=%s', sid, server, exc)
        shutdown_session_lsp_server(sid, server)
        return _sync(get_session_lsp_manager(sid, scope=scope, server=server))


def session_diagnostics_fresh(relative_path: str, *, session_id: str | None = None, scope: str = 'workspace') -> bool:
    """True when the session's cached diagnostics for ``relative_path`` match the synced text.

    Looks up an existing manager only (never starts a server); missing manager → False.
    """

    sid = (session_id or current_session_id.get() or '').strip()
    server = lsp_server_for_path(relative_path)
    if not sid or not server:
        return False
    key = (lsp_owner_session_id(sid), server, _normalize_lsp_scope(scope))
    with _MANAGERS_LOCK:
        manager = _SESSION_MANAGERS.get(key)
    return manager is not None and manager.diagnostics_fresh(relative_path)


def notify_session_lsp_disk_changes(
    session_id: str,
    paths: list[str],
    kinds: list[str],
    *,
    encoding: str = 'utf-8',
) -> None:
    """Forward a workspace watcher batch to the session's running workspace-scope servers."""

    sid = (session_id or '').strip()
    if not sid or not paths:
        return
    sid = lsp_owner_session_id(sid)
    changes = [(str(p), str(kinds[i]) if i < len(kinds) else 'unknown') for i, p in enumerate(paths)]
    with _MANAGERS_LOCK:
        managers = [mgr for k, mgr in _SESSION_MANAGERS.items() if k[0] == sid and k[2] == 'workspace']
    for manager in managers:
        try:
            manager.apply_disk_changes(changes, encoding=encoding)
        except Exception as exc:
            logger.warning(
                '%s LSP disk-change notify failed session=%s err=%s',
                manager.server_kind,
                sid,
                exc,
            )


def close_session_document(
    relative_path: str,
    *,
    session_id: str | None = None,
    scope: str | None = None,
) -> None:
    server = lsp_server_for_path(relative_path)
    if not server:
        return
    sid = (session_id or current_session_id.get() or '').strip()
    if not sid:
        return
    sid = lsp_owner_session_id(sid)
    desired = _normalize_lsp_scope(scope) if scope else None
    with _MANAGERS_LOCK:
        managers = [
            mgr
            for k, mgr in _SESSION_MANAGERS.items()
            if k[0] == sid and k[1] == server and (desired is None or k[2] == desired)
        ]
    for mgr in managers:
        mgr.close_document(relative_path)
