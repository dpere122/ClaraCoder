"""Runtime config JSON parsing (workspace tools)."""

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


def test_allow_staging_overlay_accepts_snake_case_string() -> None:
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
            'allow_staging_overlay_commands': 'true',
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.allowStagingOverlayCommands is True
