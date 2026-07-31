"""Tests for LLM tool I/O logging helpers."""

from __future__ import annotations

import logging

import pytest

from clara_coder_backend.tool_call_logging import log_llm_tool_input, log_llm_tool_output


def test_tool_invoke_logger_name() -> None:
    lg = logging.getLogger('clara.tools.invoke')
    assert lg.name == 'clara.tools.invoke'


def test_log_llm_tool_input_output_no_crash(caplog: pytest.LogCaptureFixture) -> None:
    # After other tests reload main, ``nemo`` may have propagate=False so caplog (root) must see children.
    nemo = logging.getLogger('clara')
    prev = nemo.propagate
    nemo.propagate = True
    try:
        caplog.set_level(logging.INFO, logger='clara.tools.invoke')
        log_llm_tool_input('read_workspace_file', {'relative_path': 'a.txt'}, run_id='r1', agent_role='worker')
        log_llm_tool_output('read_workspace_file', 'hello', ok=True, run_id='r1', agent_role='worker')
        in_msg = next(r.message for r in caplog.records if 'LLM tool in' in r.message)
        out_msg = next(r.message for r in caplog.records if 'LLM tool out' in r.message)
        assert in_msg.startswith('worker · read_workspace_file — LLM tool in')
        assert 'run_id=r1' in in_msg
        assert out_msg.startswith('worker · read_workspace_file — LLM tool out')
        assert 'run_id=r1' in out_msg

        caplog.clear()
        log_llm_tool_input('list_dir', {}, agent_role=None)
        bare = next(r.message for r in caplog.records if 'LLM tool in' in r.message)
        assert bare.startswith('list_dir — LLM tool in')
    finally:
        nemo.propagate = prev
