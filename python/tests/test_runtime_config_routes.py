"""Runtime-config route should update shared config in place."""

from __future__ import annotations

from copy import deepcopy

from starlette.testclient import TestClient


def _payload(
    *,
    allow_overlay: bool = False,
    allow_web: bool = False,
    searxng_base_url: str = '',
) -> dict:
    conn = {
        'id': 'x',
        'name': 't',
        'provider': 'lmstudio',
        'baseUrl': 'http://127.0.0.1:1234/v1',
        'model': 'm',
        'apiKey': '',
        'reasoningEffort': '',
        'temperature': 0.1,
        'parallelToolCalls': False,
        'optimizationPreset': 'generic',
        'maxOutputTokens': 0,
        'thinkingMode': 'default',
        'samplingPreset': 'provider-default',
        'topP': None,
        'topK': None,
        'minP': None,
        'presencePenalty': None,
        'repeatPenalty': None,
        'architectureHint': 'auto',
        'embeddingsBaseUrl': '',
        'embeddingsEnabled': True,
    }
    return {
        'activeConnectionId': 'x',
        'connections': [conn],
        'audio': {'provider': 'openai', 'baseUrl': '', 'model': 'whisper-1', 'apiKey': ''},
        'host': {'platform': 'win32', 'release': 'x', 'arch': 'x64', 'version': 'x', 'label': 'Windows'},
        'tools': {
            'editToolsStrict': False,
            'maxFileReadLines': 400,
            'maxSearchResults': 40,
            'defaultWorkspaceEncoding': 'utf-8',
            'defaultWorkspaceNewline': 'lf',
            'allowStagingOverlayCommands': allow_overlay,
            'exposeAllWorkspaceFiles': allow_overlay,
            'allowWebAccess': allow_web,
            'searxngBaseUrl': searxng_base_url,
        },
    }


def test_runtime_config_updates_imported_runtime_config_references() -> None:
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state
    from clara_coder_backend.llm import messages
    from clara_coder_backend.llm import model_tuning
    orig = deepcopy(state.runtime_config)
    try:
        with TestClient(app) as client:
            r = client.post('/runtime-config', json=_payload(allow_overlay=True))
            assert r.status_code == 200
            assert r.json()['ok'] is True

            assert state.runtime_config.tools.allow_staging_overlay_commands is True
            assert state.runtime_config.tools.expose_all_workspace_files is True
            assert messages.runtime_config.tools.allow_staging_overlay_commands is True
            assert model_tuning.runtime_config.tools.allow_staging_overlay_commands is True

            r2 = client.post('/runtime-config', json=_payload(allow_overlay=False))
            assert r2.status_code == 200
            assert r2.json()['ok'] is True
            assert state.runtime_config.tools.allow_staging_overlay_commands is False
            assert state.runtime_config.tools.expose_all_workspace_files is False
            assert messages.runtime_config.tools.allow_staging_overlay_commands is False

            r3 = client.post(
                '/runtime-config',
                json=_payload(allow_web=True, searxng_base_url='http://127.0.0.1:8080'),
            )
            assert r3.status_code == 200
            assert state.runtime_config.tools.allow_web_access is True
            assert state.runtime_config.tools.searxng_base_url == 'http://127.0.0.1:8080'
            assert messages.runtime_config.tools.allow_web_access is True
    finally:
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools
