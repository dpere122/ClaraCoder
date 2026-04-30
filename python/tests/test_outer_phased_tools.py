"""Phased outer coding graph: tool partition and compile smoke."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel

from nemo_backend.domain import RuntimeToolsConfig, SessionState


def test_phased_outer_tool_partition_matches_worker_union() -> None:
    from nemo_backend import tool_registry as tr

    cfg = RuntimeToolsConfig(orchestrated_mode=True, edit_tools_strict=False)
    with patch.object(tr, 'runtime_config', SimpleNamespace(tools=cfg)):
        full_tools, _ = tr.worker_tools_and_map(True)
        learn_tools, _ = tr.outer_phased_learn_tools_and_map()
        write_tools, _ = tr.outer_phased_write_tools_and_map()
        verify_tools, _ = tr.outer_phased_verify_tools_and_map()
        full_names = {t.name for t in full_tools}
        union = {t.name for t in learn_tools} | {t.name for t in write_tools} | {t.name for t in verify_tools}
        assert union == full_names
        assert tr.OUTER_VERIFY_ONLY_TOOL_NAMES <= {t.name for t in verify_tools}
        assert tr.OUTER_VERIFY_STAGING_TRANSFER_TOOL_NAMES <= {t.name for t in verify_tools}
        assert tr.OUTER_VERIFY_ONLY_TOOL_NAMES.isdisjoint({t.name for t in write_tools})
        verify_order = [t.name for t in verify_tools]
        last_transfer_i = max(verify_order.index(n) for n in tr.OUTER_VERIFY_STAGING_TRANSFER_TOOL_NAMES)
        first_test_i = min(verify_order.index(n) for n in tr.OUTER_VERIFY_ONLY_TOOL_NAMES)
        assert last_transfer_i < first_test_i, 'verify tools: staging transfer before pytest/smoke'


@pytest.mark.asyncio(loop_scope='function')
async def test_outer_phased_coding_graph_compiles(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv('NEMO_CHECKPOINT_DB', str(tmp_path / 'phased_outer.sqlite'))
    from nemo_backend.checkpointing import init_graph_checkpointing, shutdown_graph_checkpointing
    from nemo_backend.outer_coding_cycle_graph import build_outer_phased_coding_cycle_graph

    await init_graph_checkpointing()
    try:
        llm = FakeListChatModel(responses=['ok'])
        g = build_outer_phased_coding_cycle_graph(llm, SessionState(), True, extra_middleware=None)
        assert callable(getattr(g, 'ainvoke', None))
    finally:
        await shutdown_graph_checkpointing()
