"""Per-language-server LSP lifecycle hooks (pluggable backends).

Each integrated LSP (Python, TypeScript/JavaScript, GDScript, …) implements
:class:`LspServerPlugin`. :class:`~nemo_backend.lsp.manager.SessionWorkspaceLspManager`
delegates start/sync/shutdown semantics to the active plugin without branching on
server ids in the manager itself.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from nemo_backend.domain import SessionState

__all__ = [
    'LspStartParams',
    'LspServerPlugin',
]


@dataclass(frozen=True)
class LspStartParams:
    """Resolved cwd, argv, and ``initialize`` options for one LSP subprocess."""

    lsp_cwd: Path
    command: list[str]
    init_options: dict[str, Any]


class LspServerPlugin(ABC):
    """Language-server specific behavior isolated from session manager."""

    #: Stable id matching ``LspFilePolicy.lsp_server`` (e.g. ``python``).
    server_id: str

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
    ) -> bool:
        """Update plugin state before ``ensure_started``; return True if the client must restart first."""

        return False

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

