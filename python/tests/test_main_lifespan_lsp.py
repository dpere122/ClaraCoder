"""LSP managers are shut down during FastAPI lifespan cleanup."""

from __future__ import annotations

from unittest.mock import patch

from starlette.testclient import TestClient


def test_lifespan_shutdown_calls_shutdown_all_lsp_managers() -> None:
    from clara_coder_backend.main import app

    with patch('clara_coder_backend.main.shutdown_all_lsp_managers') as shutdown_lsp:
        with TestClient(app):
            pass
    shutdown_lsp.assert_called_once()


def test_lifespan_still_awaits_checkpoint_shutdown_when_lsp_raises() -> None:
    from unittest.mock import AsyncMock

    from clara_coder_backend.main import app

    with patch('clara_coder_backend.main.shutdown_all_lsp_managers', side_effect=RuntimeError('boom')):
        with patch('clara_coder_backend.main.shutdown_graph_checkpointing', new_callable=AsyncMock) as ck_shutdown:
            with TestClient(app):
                pass
    ck_shutdown.assert_awaited_once()
