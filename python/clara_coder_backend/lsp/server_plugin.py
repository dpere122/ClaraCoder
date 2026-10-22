"""Per-language-server LSP lifecycle hooks (pluggable backends).

Each integrated LSP (Python, TypeScript/JavaScript, GDScript, Java, …) implements
:class:`LspServerPlugin`. :class:`~clara_coder_backend.lsp.manager.SessionWorkspaceLspManager`
delegates start/sync/shutdown semantics to the active plugin without branching on
server ids in the manager itself.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from clara_coder_backend.domain import SessionState

__all__ = [
    'LspStartParams',
    'LspServerPlugin',
]


@dataclass(frozen=True)
class LspStartParams:
    """Resolved cwd, argv, ``initialize`` options, and optional subprocess env for one LSP subprocess."""

    lsp_cwd: Path
    command: list[str]
    init_options: dict[str, Any]
    # When set, merged over the inherited environment for the subprocess, overrides winning
    # (e.g. to run a bundled Node LSP via the Electron binary in Node mode with
    # ``ELECTRON_RUN_AS_NODE=1`` while keeping PATH/HOME/SystemRoot intact).
    env: dict[str, str] | None = None
    # ``initialize`` handshake timeout. JDT LS JVM + OSGi start often exceeds the 20s default.
    startup_timeout_s: float | None = None


class LspServerPlugin(ABC):
    """Language-server specific behavior isolated from session manager."""

    #: Stable id matching ``LspFilePolicy.lsp_server`` (e.g. ``python``).
    server_id: str

    #: Server needs the longer diagnostics wait (project load / build before publishing).
    slow_diagnostics: bool = False

    #: For servers whose ``publishDiagnostics`` carries no ``version``: a publish that arrives
    #: sooner than this after a change was computed for the previous text (already in flight).
    unversioned_publish_min_delay_s: float = 0.0

    #: Server publishes only when a file's diagnostics change (nothing for a clean file on open or
    #: for clean → clean edits). Silence through the wait window then means the cache still applies.
    silent_when_diagnostics_unchanged: bool = False

    @abstractmethod
    def create_state(self) -> Any:
        """Mutable per-manager state (e.g. TypeScript project root + last seed)."""

    @abstractmethod
    def compute_start_params(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
        session_id: str = '',
        scope: str = 'workspace',
    ) -> LspStartParams:
        """Return cwd + command + initializationOptions for ``initialize``."""

    def should_defer_semantic_tokens_legend_without_document_seed(self, state: Any) -> bool:
        """If True, ``GET /lsp/semantic-tokens-legend`` returns unsupported without spawning."""

        return False

    def on_before_sync_document(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        relative_posix_path: str,
        state: Any,
        client_running: bool,
        text: str | None = None,
    ) -> bool:
        """Update plugin state before ``ensure_started``; return True if the client must restart first.

        ``text`` is the document content being synced (may differ from disk).
        """

        return False

    def take_pending_initialization_options(self, state: Any) -> dict[str, Any] | None:
        """Options to push via ``workspace/didChangeConfiguration`` without a restart (consumed once)."""

        return None

    def after_shutdown(self, session: SessionState, state: Any) -> None:
        """Clear session fields tied to this server after the subprocess stops."""

    def on_after_client_started(
        self,
        *,
        session: SessionState,
        workspace_root: Path,
        state: Any,
        lsp_cwd: Path,
    ) -> None:
        """Optional hook after ``initialize`` succeeds (e.g. persist resolved TS root)."""

