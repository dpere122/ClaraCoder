"""Runtime-config route should update shared config in place."""

from __future__ import annotations

from copy import deepcopy

from starlette.testclient import TestClient


def _payload(orchestrated: bool) -> dict:
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
        'planRetryAttemptsCount': 2,
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
            'orchestratedMode': orchestrated,
        },
    }


def test_runtime_config_updates_imported_runtime_config_references() -> None:
    from nemo_backend.main import app
    from nemo_backend import state
    from nemo_backend import agent_langgraph, messages, model_tuning

    orig = deepcopy(state.runtime_config)
    try:
        with TestClient(app) as client:
            r = client.post('/runtime-config', json=_payload(True))
            assert r.status_code == 200
            assert r.json()['orchestratedMode'] is True

            assert state.runtime_config.tools.orchestrated_mode is True
            assert messages.runtime_config.tools.orchestrated_mode is True
            assert model_tuning.runtime_config.tools.orchestrated_mode is True
            assert agent_langgraph.runtime_config.tools.orchestrated_mode is True

            r2 = client.post('/runtime-config', json=_payload(False))
            assert r2.status_code == 200
            assert r2.json()['orchestratedMode'] is False
            assert messages.runtime_config.tools.orchestrated_mode is False
    finally:
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools
