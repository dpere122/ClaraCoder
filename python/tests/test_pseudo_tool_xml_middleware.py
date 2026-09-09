from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from clara_coder_backend.llm.messages import extract_pseudo_tool_calls, text_uses_pseudo_tool_markup
from clara_coder_backend.middleware.pseudo_tool_xml_middleware import PseudoToolXmlMiddleware

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


def test_extract_pseudo_tool_calls_ampersand_in_args() -> None:
    pseudo = (
        '<tool_call><function=run_command>'
        '<parameter name="command">npm run build && npm test</parameter>'
        '</function></tool_call>'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['name'] == 'run_command'
    assert got[0]['args'] == {'command': 'npm run build && npm test'}


def test_extract_pseudo_tool_calls_embedded_in_reasoning_prose() -> None:
    pseudo = (
        'I need to compare if a < b and then run:\n'
        '<tool_call><function=run_command>'
        '<parameter name="command">echo foo && echo bar</parameter>'
        '</function></tool_call>\n'
        'After that, check a > b.'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['name'] == 'run_command'
    assert got[0]['args'] == {'command': 'echo foo && echo bar'}


def test_extract_pseudo_tool_calls_function_name_attribute_form() -> None:
    pseudo = (
        '<function name="list_workspace_directory">'
        '<parameter name="relative_path">src</parameter>'
        '</function>'
    )
    assert text_uses_pseudo_tool_markup(pseudo) is True
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['name'] == 'list_workspace_directory'
    assert got[0]['args'] == {'relative_path': 'src'}


def test_extract_does_not_double_escape_entities() -> None:
    pseudo = (
        '<tool_call><function=run_command>'
        '<parameter name="command">echo &amp;&amp; true</parameter>'
        '</function></tool_call>'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['args'] == {'command': 'echo && true'}


def test_extract_keeps_sibling_block_when_neighbor_is_truncated() -> None:
    pseudo = (
        '<tool_call><function=run_command>'
        '<parameter name="command">echo ok</parameter>'
        '</function></tool_call>\n'
        '<tool_call><function=run_command><parameter name="command">'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['args'] == {'command': 'echo ok'}


def test_extract_escapes_html_entities_that_xml_does_not_define() -> None:
    pseudo = (
        '<tool_call><function=write_workspace_file>'
        '<parameter name="content">a&nbsp;b &copy; 2026 &amp; done</parameter>'
        '</function></tool_call>'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['args'] == {'content': 'a&nbsp;b &copy; 2026 & done'}


def test_extract_keeps_html_input_tags_inside_argument_text() -> None:
    pseudo = (
        '<tool_call><function=write_workspace_file>'
        '<parameter name="relative_path">form.html</parameter>'
        '<parameter name="content"><form><input type="text" name="q"><input type="submit"></form></parameter>'
        '</function></tool_call>'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['name'] == 'write_workspace_file'
    assert got[0]['args']['relative_path'] == 'form.html'
    assert got[0]['args']['content'] == '<form><input type="text" name="q"><input type="submit"></form>'


def test_extract_parameter_equals_form_with_ampersand() -> None:
    pseudo = (
        '<function=run_command>'
        '<parameter=command>npm run build && npm test</parameter>'
        '</function>'
    )
    got = extract_pseudo_tool_calls(pseudo)
    assert len(got) == 1
    assert got[0]['name'] == 'run_command'
    assert got[0]['args'] == {'command': 'npm run build && npm test'}


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
async def test_pseudo_tool_xml_middleware_promotes_ampersand_in_args() -> None:
    middleware = PseudoToolXmlMiddleware()
    pseudo = (
        'Reasoning: compare a < b then run the suite.\n'
        '<tool_call><function=run_command>'
        '<parameter name="command">npm run build && npm test</parameter>'
        '</function></tool_call>'
    )
    result = await middleware.aafter_model({'messages': [AIMessage(content=pseudo)]}, MagicMock())
    assert result is not None
    promoted = result['messages'][0]
    assert promoted.tool_calls[0]['name'] == 'run_command'
    assert promoted.tool_calls[0]['args'] == {'command': 'npm run build && npm test'}


@pytest.mark.asyncio(loop_scope='function')
async def test_pseudo_tool_xml_middleware_ignores_invalid_markup() -> None:
    middleware = PseudoToolXmlMiddleware()
    pseudo = '<tool_call><function=list_workspace_directory><parameter name="relative_path">'
    result = await middleware.aafter_model({'messages': [AIMessage(content=pseudo)]}, MagicMock())
    assert result is None
