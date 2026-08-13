"""Runtime config JSON parsing (workspace tools)."""

from __future__ import annotations

from clara_coder_backend.session.schemas import RuntimeConfigRequest, RuntimeConnectionRequest

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
            'expose_all_workspace_files': 'true',
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.allowStagingOverlayCommands is True
    assert r.tools.exposeAllWorkspaceFiles is True


def test_allow_web_access_and_searxng_base_url() -> None:
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
            'allow_web_access': 'true',
            'searxng_base_url': '  http://127.0.0.1:8080/  ',
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.allowWebAccess is True
    assert r.tools.searxngBaseUrl == 'http://127.0.0.1:8080'


def test_legacy_capable_optimization_preset_maps_to_generic() -> None:
    conn = {**_CONN, 'optimizationPreset': 'capable'}
    r = RuntimeConnectionRequest.model_validate(conn)
    assert r.optimizationPreset == 'generic'
