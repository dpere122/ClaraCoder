"""Screenshot tool privacy, broker protocol, binding and deferred approval tests."""

from __future__ import annotations

import io
import json
import socket
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from clara_coder_backend.domain import RuntimeToolsConfig
from clara_coder_backend.hitl.accept_command import execute_pending_accept_command_decision
from clara_coder_backend.hitl.tool_registry import (
    format_tools_catalog,
    hitl_accept_command_pause_tools,
    worker_tools_and_map,
)
from clara_coder_backend.llm.messages import _web_access_operational_bullet
from clara_coder_backend.session.state import current_session_id, get_session, runtime_config
from clara_coder_backend.tools import screenshot_webpage as screenshot
from clara_coder_backend.tools.deferred_hitl import DEFERRED_HITL_TOOL_NAMES, deferred_tool_hitl_bypass
from clara_coder_backend.tools.http_guards import assert_public_http_url

_ASSET_URL = 'nemo-asset://capture/0123456789abcdef0123456789abcdef.png'
_TARGET = 'https://example.com/page'
_BROKER_URL = 'http://127.0.0.1:54321/capture'
_BROKER_TOKEN = 'screenshot-broker-secret'
_USER_AGENT = 'ClaraScreenshotTest/1.0'


def _success(**overrides):
    return {'image_url': _ASSET_URL, 'url': _TARGET, 'width': 1280, 'height': 800, **overrides}


class _Response(io.BytesIO):
    def __init__(self, payload):
        super().__init__(payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8'))
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)


@pytest.fixture()
def screenshot_env(monkeypatch):
    monkeypatch.setattr(
        runtime_config,
        'tools',
        RuntimeToolsConfig(allow_web_access=True, web_search_user_agent=_USER_AGENT),
    )
    monkeypatch.setenv('CLARA_SCREENSHOT_URL', _BROKER_URL)
    monkeypatch.setenv('CLARA_SCREENSHOT_TOKEN', _BROKER_TOKEN)
    sid = 'test-screenshot-webpage'
    session = get_session(sid)
    session.auto_apply_mode = True
    session.pending_accept_command_request = None
    token = current_session_id.set(sid)
    bypass_token = deferred_tool_hitl_bypass.set(False)
    public = Mock(return_value=None)
    response = _Response(_success())
    opener = Mock()
    opener.open.return_value = response
    build_opener = Mock(return_value=opener)
    dns = Mock(side_effect=AssertionError('tests must not resolve real DNS'))
    monkeypatch.setattr(screenshot, 'assert_public_http_url', public)
    monkeypatch.setattr(urllib.request, 'build_opener', build_opener)
    monkeypatch.setattr(socket, 'getaddrinfo', dns)
    try:
        yield SimpleNamespace(
            session=session,
            sid=sid,
            public=public,
            response=response,
            opener=opener,
            build_opener=build_opener,
            dns=dns,
        )
    finally:
        session.pending_accept_command_request = None
        current_session_id.reset(token)
        deferred_tool_hitl_bypass.reset(bypass_token)


def _assert_no_io(env):
    env.public.assert_not_called()
    env.dns.assert_not_called()
    env.build_opener.assert_not_called()
    env.opener.open.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_web_access_makes_no_requests(screenshot_env, monkeypatch):
    monkeypatch.setattr(runtime_config.tools, 'allow_web_access', False)
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'web access is disabled' in result
    _assert_no_io(screenshot_env)
    assert screenshot_env.session.pending_accept_command_request is None


@pytest.mark.asyncio
async def test_active_session_is_required(screenshot_env):
    token = current_session_id.set('')
    try:
        result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    finally:
        current_session_id.reset(token)
    assert result == 'Tool error: no active session.'
    _assert_no_io(screenshot_env)


@pytest.mark.asyncio
async def test_approval_gate_precedes_dns_and_broker_io(screenshot_env):
    screenshot_env.session.auto_apply_mode = False
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET, 'width': 1000, 'height': 600})
    assert 'Pending user confirmation' in result
    _assert_no_io(screenshot_env)
    pending = screenshot_env.session.pending_accept_command_request
    assert pending['kind'] == 'deferred_tool'
    assert pending['title'] == 'Screenshot webpage'
    assert pending['command_text'] == _TARGET
    assert pending['action'] == {
        'tool_name': 'screenshot_webpage',
        'tool_input': {'url': _TARGET, 'width': 1000, 'height': 600},
    }
    assert f'User-Agent: `{_USER_AGENT}`' in pending['details']
    assert 'Viewport: `1000 × 600`' in pending['details']
    assert any('Sandbox:' in detail and 'static' in detail for detail in pending['details'])
    assert _BROKER_TOKEN not in str(pending)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'url',
    [
        '',
        'file:///C:/secret.txt',
        'ftp://example.com/file',
        'javascript:alert(1)',
        'data:image/png;base64,AAAA',
        'nemo-asset://capture/a.png',
        'https:///missing-host',
        'https://example.com:bad/',
        'https://example.com:0/',
        'https://example.com:65536/',
        'https://[bad-ipv6]/',
        'https://user:password@example.com/',
        'https://@example.com/',
        'https://user%2540example.com/',
        'https://example.com\\@127.0.0.1/',
        'https://example.com/%255csecret',
        'https://example.com/\nsecret',
        'https://example.com/%250dsecret',
        'https://example.com/space here',
        'https://example.com/' + 'x' * 2048,
        'https://example.com/?q=' + '%25' + '25' * 20 + '40',
    ],
)
async def test_invalid_url_is_rejected_before_approval_or_io(screenshot_env, url):
    screenshot_env.session.auto_apply_mode = False
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': url})
    assert result.startswith('Tool error:')
    _assert_no_io(screenshot_env)
    assert screenshot_env.session.pending_accept_command_request is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'address',
    [
        'daniel@example.com',
        'daniel%40example.com',
        'daniel%2540example%252Ecom',
        '%2564aniel%2540example%252ecom',
        'daniel%252540example%25252Ecom',
    ],
)
async def test_email_url_is_rejected_not_redacted_and_requested(screenshot_env, address):
    screenshot_env.session.auto_apply_mode = False
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': f'https://example.com/?q={address}'})
    assert 'email addresses' in result
    assert address not in result
    _assert_no_io(screenshot_env)
    assert screenshot_env.session.pending_accept_command_request is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'user_agent, reason',
    [
        ('Clara contact=daniel@example.com', 'email'),
        ('Clara contact=daniel%2540example%252ecom', 'email'),
        ('Clara\r\nX-Secret: hidden', 'control'),
        ('Clara\x00', 'control'),
        ('Clara\x85', 'control'),
        ('Clara ☃', 'ASCII'),
    ],
)
async def test_unsafe_configured_user_agent_is_rejected_before_gate(screenshot_env, monkeypatch, user_agent, reason):
    screenshot_env.session.auto_apply_mode = False
    monkeypatch.setattr(runtime_config.tools, 'web_search_user_agent', user_agent)
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'User-Agent' in result and reason in result
    assert 'daniel' not in result
    _assert_no_io(screenshot_env)
    assert screenshot_env.session.pending_accept_command_request is None


@pytest.mark.asyncio
@pytest.mark.parametrize('dimension,value', [('width', 0), ('height', -1), ('width', 4097), ('width', 319), ('height', 1081)])
async def test_viewport_bounds(screenshot_env, dimension, value):
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET, dimension: value})
    assert 'width 320–1920, height 240–1080' in result
    _assert_no_io(screenshot_env)


@pytest.mark.asyncio
@pytest.mark.parametrize('value', [True, 12.5, '1280'])
async def test_viewport_requires_integer_schema(screenshot_env, value):
    with pytest.raises(ValidationError):
        await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET, 'width': value})
    _assert_no_io(screenshot_env)


@pytest.mark.asyncio
@pytest.mark.parametrize('url', ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/'])
async def test_nonpublic_target_is_blocked_after_gate_without_broker_request(screenshot_env, monkeypatch, url):
    monkeypatch.setattr(screenshot, 'assert_public_http_url', assert_public_http_url)
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': url})
    assert 'non-public' in result
    screenshot_env.dns.assert_not_called()
    screenshot_env.build_opener.assert_not_called()


@pytest.mark.asyncio
async def test_public_validation_failure_does_not_contact_broker(screenshot_env):
    screenshot_env.public.return_value = 'Tool error: host resolves to a non-public address (blocked).'
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'non-public' in result
    screenshot_env.public.assert_called_once_with(_TARGET)
    screenshot_env.build_opener.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'broker_url',
    [
        '',
        'https://127.0.0.1:54321/capture',
        'http://localhost:54321/capture',
        'http://[::1]:54321/capture',
        'http://127.0.0.2:54321/capture',
        'http://127.0.0.1.evil.example:54321/capture',
        'http://127.0.0.1:54321/capture?x=1',
        'http://127.0.0.1:54321/capture#x',
        'http://127.0.0.1:54321/capture/',
        'http://127.0.0.1:54321/%63apture',
        'http://user:password@127.0.0.1:54321/capture',
        'http://127.0.0.1:0/capture',
        'http://127.0.0.1:65536/capture',
        'http://127.0.0.1:54321/capture\n',
    ],
)
async def test_broker_endpoint_must_be_exact_loopback_capture_url(screenshot_env, monkeypatch, broker_url):
    monkeypatch.setenv('CLARA_SCREENSHOT_URL', broker_url)
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'loopback URL' in result
    _assert_no_io(screenshot_env)


@pytest.mark.asyncio
@pytest.mark.parametrize('token', ['', 'secret\nother', 'secret token', '☃'])
async def test_broker_token_must_be_safe_and_present(screenshot_env, monkeypatch, token):
    monkeypatch.setenv('CLARA_SCREENSHOT_TOKEN', token)
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'authentication' in result
    _assert_no_io(screenshot_env)


@pytest.mark.asyncio
async def test_broker_auth_body_timeout_proxy_isolation_and_asset_output(screenshot_env, monkeypatch):
    monkeypatch.setenv('HTTP_PROXY', 'http://untrusted.example:8080')
    monkeypatch.setenv('HTTPS_PROXY', 'http://untrusted.example:8080')
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    screenshot_env.build_opener.assert_called_once()
    handlers = screenshot_env.build_opener.call_args.args
    assert isinstance(handlers[0], urllib.request.ProxyHandler)
    assert handlers[0].proxies == {}
    assert isinstance(handlers[1], screenshot._NoBrokerRedirects)
    request = screenshot_env.opener.open.call_args.args[0]
    assert request.full_url == _BROKER_URL
    assert request.get_method() == 'POST'
    assert request.get_header('Authorization') == f'Bearer {_BROKER_TOKEN}'
    assert request.get_header('Content-type') == 'application/json'
    assert json.loads(request.data) == {
        'url': _TARGET,
        'width': 1280,
        'height': 800,
        'user_agent': _USER_AGENT,
    }
    assert screenshot_env.opener.open.call_args.kwargs == {'timeout': 40.0}
    assert screenshot_env.response.read_sizes == [16 * 1024 + 1]
    assert [call.args[0] for call in screenshot_env.public.call_args_list] == [_TARGET, _TARGET]
    assert f'![Webpage screenshot]({_ASSET_URL})' in result
    assert 'Embed the exact Markdown image above in your reply' in result
    assert '1280 × 800' in result
    assert 'base64' not in result
    assert _BROKER_TOKEN not in result
    assert len(result) < 600
    assert screenshot_env.session.pending_accept_command_request is None


@pytest.mark.asyncio
async def test_direct_online_image_and_encoded_url_are_sent_unchanged(screenshot_env):
    target = 'https://example.com/images/hello%20world.png?x=%2520'
    screenshot_env.opener.open.return_value = _Response(_success(url=target, width=1000, height=600))
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': target, 'width': 1000, 'height': 600})
    assert json.loads(screenshot_env.opener.open.call_args.args[0].data)['url'] == target
    assert f'![Webpage screenshot]({_ASSET_URL})' in result
    assert '1000 × 600' in result


@pytest.mark.asyncio
async def test_default_user_agent_comes_from_shared_helper(screenshot_env, monkeypatch):
    monkeypatch.setattr(runtime_config.tools, 'web_search_user_agent', '')
    shared = Mock(return_value='SharedSafeUA/1.0')
    monkeypatch.setattr(screenshot, 'outbound_user_agent', shared)
    await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    shared.assert_called_once_with()
    assert json.loads(screenshot_env.opener.open.call_args.args[0].data)['user_agent'] == 'SharedSafeUA/1.0'


@pytest.mark.asyncio
async def test_http_json_failure_is_compact_and_redacted(screenshot_env):
    message = f'blocked target; contact=daniel@example.com; token={_BROKER_TOKEN}'
    screenshot_env.opener.open.side_effect = urllib.error.HTTPError(
        _BROKER_URL, 403, 'Forbidden', {}, io.BytesIO(json.dumps({'error': message}).encode()),
    )
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'HTTP 403' in result and 'blocked target' in result
    assert 'daniel@example.com' not in result
    assert _BROKER_TOKEN not in result
    assert '![Webpage screenshot]' not in result


@pytest.mark.asyncio
@pytest.mark.parametrize('error', [TimeoutError(), urllib.error.URLError('secret-in-error'), OSError('secret-in-error')])
async def test_request_failure_does_not_leak_exception_details(screenshot_env, error):
    screenshot_env.opener.open.side_effect = error
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert result.startswith('Tool error: screenshot broker')
    assert 'secret-in-error' not in result


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [b'not JSON', b'\xff', b'[]', b'x' * (16 * 1024 + 1)])
async def test_malformed_or_oversized_broker_responses_are_rejected(screenshot_env, payload):
    response = _Response(payload)
    screenshot_env.opener.open.return_value = response
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert result.startswith('Tool error: screenshot broker')
    assert '![Webpage screenshot]' not in result
    assert response.read_sizes == [16 * 1024 + 1]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'asset_url',
    [
        'https://example.com/image.png',
        'file:///C:/secret.png',
        'data:image/png;base64,AAAA',
        'nemo-asset://capture/' + 'A' * 32 + '.png',
        'nemo-asset://capture/' + 'a' * 31 + '.png',
        'nemo-asset://capture/' + 'a' * 32 + '.svg',
        _ASSET_URL + '?x=1',
        _ASSET_URL + '\n',
        'nemo-asset://capture/../' + 'a' * 32 + '.png',
        None,
    ],
)
async def test_only_exact_capture_asset_urls_are_returned(screenshot_env, asset_url):
    screenshot_env.opener.open.return_value = _Response(_success(image_url=asset_url))
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'invalid capture asset URL' in result
    assert '![Webpage screenshot]' not in result


@pytest.mark.asyncio
@pytest.mark.parametrize('final_url', ['file:///C:/secret', 'https://a:b@example.com/', 'https://example.com/?q=a%2540b.com', None])
async def test_unsafe_final_urls_are_rejected(screenshot_env, final_url):
    screenshot_env.opener.open.return_value = _Response(_success(url=final_url))
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'unsafe final URL' in result
    assert '![Webpage screenshot]' not in result


@pytest.mark.asyncio
async def test_final_url_is_publicly_validated(screenshot_env):
    screenshot_env.public.side_effect = [None, 'Tool error: non-public redirect']
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'non-public final URL' in result
    assert '![Webpage screenshot]' not in result


@pytest.mark.asyncio
@pytest.mark.parametrize('value', [0, 4097, True, '1280', None])
async def test_invalid_returned_dimensions_are_rejected(screenshot_env, value):
    screenshot_env.opener.open.return_value = _Response(_success(width=value))
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'invalid image dimensions' in result


def test_broker_redirects_are_never_followed():
    handler = screenshot._NoBrokerRedirects()
    request = urllib.request.Request(_BROKER_URL, headers={'Authorization': f'Bearer {_BROKER_TOKEN}'})
    assert handler.redirect_request(request, None, 302, 'Found', {}, 'https://evil.example/') is None


def test_tool_binding_registry_and_compact_catalog(screenshot_env, monkeypatch):
    tools, mapping = worker_tools_and_map(False)
    assert mapping['screenshot_webpage'] is screenshot.screenshot_webpage_tool
    assert 'screenshot_webpage' in {tool.name for tool in tools}
    assert 'screenshot_webpage' in DEFERRED_HITL_TOOL_NAMES
    assert 'screenshot_webpage' in hitl_accept_command_pause_tools()
    catalog = format_tools_catalog(tools)
    web_catalog = catalog.split('**Web**', 1)[1].split('**', 1)[0]
    assert '`screenshot_webpage`' in web_catalog
    properties = screenshot.screenshot_webpage_tool.get_input_schema().model_json_schema()['properties']
    assert set(properties) == {'url', 'width', 'height'}
    assert properties['width']['default'] == 1280
    assert properties['height']['default'] == 800
    monkeypatch.setattr(runtime_config.tools, 'allow_web_access', False)
    tools, mapping = worker_tools_and_map(False)
    assert 'screenshot_webpage' not in mapping
    assert 'screenshot_webpage' not in {tool.name for tool in tools}


def test_web_prompt_mentions_static_capture_and_embedding(screenshot_env, monkeypatch):
    guidance = _web_access_operational_bullet()
    assert '`screenshot_webpage`' in guidance
    assert 'static captures' in guidance and 'script-dependent' in guidance
    assert 'Markdown image verbatim' in guidance
    monkeypatch.setattr(runtime_config.tools, 'allow_web_access', False)
    assert _web_access_operational_bullet() == ''


@pytest.mark.asyncio
async def test_approval_resumes_actual_tool_with_session_context(screenshot_env):
    screenshot_env.session.auto_apply_mode = False
    pending_result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert 'Pending user confirmation' in pending_result
    _assert_no_io(screenshot_env)
    request_id = screenshot_env.session.pending_accept_command_request['request_id']
    token = current_session_id.set('')
    try:
        result = await execute_pending_accept_command_decision(
            screenshot_env.session, confirm=True, request_id=request_id,
        )
        assert current_session_id.get() == ''
    finally:
        current_session_id.reset(token)
    assert f'![Webpage screenshot]({_ASSET_URL})' in result
    screenshot_env.opener.open.assert_called_once()
    assert screenshot_env.session.pending_accept_command_request is None
    assert not deferred_tool_hitl_bypass.get()


@pytest.mark.asyncio
async def test_cancelled_approval_never_resolves_or_captures(screenshot_env):
    screenshot_env.session.auto_apply_mode = False
    await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    result = await execute_pending_accept_command_decision(
        screenshot_env.session,
        confirm=False,
        request_id=screenshot_env.session.pending_accept_command_request['request_id'],
    )
    assert 'cancelled' in result
    _assert_no_io(screenshot_env)
    assert screenshot_env.session.pending_accept_command_request is None


@pytest.mark.asyncio
async def test_web_access_is_rechecked_on_approval_resume(screenshot_env, monkeypatch):
    screenshot_env.session.auto_apply_mode = False
    await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    monkeypatch.setattr(runtime_config.tools, 'allow_web_access', False)
    result = await execute_pending_accept_command_decision(
        screenshot_env.session,
        confirm=True,
        request_id=screenshot_env.session.pending_accept_command_request['request_id'],
    )
    assert 'web access is disabled' in result
    _assert_no_io(screenshot_env)


@pytest.mark.asyncio
@pytest.mark.parametrize('url', ['https://' + 'x' * 64 + '.com/', 'https://example.com/' + chr(0xD800)])
async def test_invalid_unicode_or_idna_url_is_rejected_without_io(screenshot_env, url):
    screenshot_env.session.auto_apply_mode = False
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': url})
    assert result.startswith('Tool error:')
    _assert_no_io(screenshot_env)
    assert screenshot_env.session.pending_accept_command_request is None


@pytest.mark.asyncio
async def test_response_at_exact_size_limit_is_accepted(screenshot_env):
    body = json.dumps(_success()).encode()
    screenshot_env.opener.open.return_value = _Response(body + b' ' * (16 * 1024 - len(body)))
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert f'![Webpage screenshot]({_ASSET_URL})' in result


@pytest.mark.asyncio
async def test_success_reports_validated_final_url_not_original_target(screenshot_env):
    final_url = 'https://example.org/redirected'
    screenshot_env.opener.open.return_value = _Response(_success(url=final_url))
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert final_url in result
    assert [call.args[0] for call in screenshot_env.public.call_args_list] == [_TARGET, final_url]


@pytest.mark.asyncio
async def test_json_error_without_http_failure_still_fails(screenshot_env):
    screenshot_env.opener.open.return_value = _Response({'error': 'capture cancelled'})
    result = await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    assert result.startswith('Tool error:') and 'capture cancelled' in result
    assert '![Webpage screenshot]' not in result


@pytest.mark.asyncio
async def test_user_agent_privacy_is_rechecked_on_resume(screenshot_env, monkeypatch):
    screenshot_env.session.auto_apply_mode = False
    await screenshot.screenshot_webpage_tool.ainvoke({'url': _TARGET})
    monkeypatch.setattr(runtime_config.tools, 'web_search_user_agent', 'Clara contact=daniel@example.com')
    result = await execute_pending_accept_command_decision(
        screenshot_env.session,
        confirm=True,
        request_id=screenshot_env.session.pending_accept_command_request['request_id'],
    )
    assert 'User-Agent must not contain email addresses' in result
    _assert_no_io(screenshot_env)
