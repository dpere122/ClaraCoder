from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from nemo_backend.messages import extract_pseudo_tool_calls
from nemo_backend.pseudo_tool_xml_middleware import PseudoToolXmlMiddleware

def test_extract_pseudo_tool_calls_function_equals_syntax() -> None:
    pseudo = (
        '<tool_call><function=list_workspace_directory>'
        '<parameter name="relative_path">src</parameter></function></tool_call>'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['name'] == 'list_workspace_directory'
    assert got[0]['args'] == {'relative_path': 'src'}


def test_extract_pseudo_tool_calls_arguments_json() -> None:
    pseudo = (
        '<tool_call><function=search_workspace>'
        '<arguments>{"query":"TODO","relative_path":"python"}</arguments>'
        '</function></tool_call>'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['name'] == 'search_workspace'
    assert got[0]['args'] == {'query': 'TODO', 'relative_path': 'python'}


@pytest.mark.asyncio(loop_scope='function')
async def test_pseudo_tool_xml_middleware_promotes_tool_call() -> None:
    middleware = PseudoToolXmlMiddleware()
    pseudo = (
        '<tool_call><function=list_workspace_directory>'
        '<parameter name="relative_path">server</parameter></function></tool_call>'
    )
    result = await middleware.aafter_model({'messages': [AIMessage(content=pseudo)]}, MagicMock())
    assert result is not None
    promoted = result['messages'][0]
    assert isinstance(promoted, AIMessage)
    assert promoted.tool_calls
    assert promoted.tool_calls[0]['name'] == 'list_workspace_directory'
    assert promoted.tool_calls[0]['args'] == {'relative_path': 'server'}


@pytest.mark.asyncio(loop_scope='function')
async def test_pseudo_tool_xml_middleware_ignores_invalid_markup() -> None:
    middleware = PseudoToolXmlMiddleware()
    pseudo = '<tool_call><function=list_workspace_directory><parameter name="relative_path">'
    result = await middleware.aafter_model({'messages': [AIMessage(content=pseudo)]}, MagicMock())
    assert result is None
