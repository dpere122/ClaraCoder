"""Runtime config JSON parsing (orchestrated mode aliases)."""

from __future__ import annotations

from nemo_backend.schemas import RuntimeConfigRequest

_CONN = {
    'id': 'x',
    'name': 't',
    'provider': 'lmstudio',
    'baseUrl': '',
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


def test_orchestrated_mode_accepts_snake_case_and_string() -> None:
    body = {
        'activeConnectionId': 'x',
        'connections': [_CONN],
        'audio': {'provider': 'openai', 'baseUrl': '', 'model': 'whisper-1', 'apiKey': ''},
        'tools': {
            'editToolsStrict': False,
            'maxFileReadLines': 400,
            'maxSearchResults': 40,
            'defaultWorkspaceEncoding': 'utf-8',
            'defaultWorkspaceNewline': 'lf',
            'orchestrated_mode': 'true',
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.orchestratedMode is True


def test_orchestrated_mode_accepts_camel_case_bool() -> None:
    body = {
        'activeConnectionId': 'x',
        'connections': [_CONN],
        'audio': {'provider': 'openai', 'baseUrl': '', 'model': 'whisper-1', 'apiKey': ''},
        'tools': {
            'editToolsStrict': False,
            'maxFileReadLines': 400,
            'maxSearchResults': 40,
            'defaultWorkspaceEncoding': 'utf-8',
            'defaultWorkspaceNewline': 'lf',
            'orchestratedMode': True,
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.orchestratedMode is True
