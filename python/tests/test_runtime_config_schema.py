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


def test_chat_template_reasoning_caps_optional() -> None:
    r = RuntimeConnectionRequest.model_validate(_CONN)
    assert r.chatTemplateReasoning is None
    conn = {
        **_CONN,
        'chatTemplateReasoning': {'enableThinking': True, 'reasoningEffortValues': ['low', 'medium']},
    }
    r2 = RuntimeConnectionRequest.model_validate(conn)
    assert r2.chatTemplateReasoning is not None
    assert r2.chatTemplateReasoning.enableThinking is True
    assert r2.chatTemplateReasoning.reasoningEffortValues == ['low', 'medium']


def test_whisper_audio_provider_and_custom_models_dir() -> None:
    body = {
        'activeConnectionId': 'x',
        'connections': [_CONN],
        'audio': {
            'provider': 'whisper',
            'baseUrl': '',
            'model': 'small',
            'apiKey': '',
            'customModelsDir': 'C:/models',
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.audio.provider == 'whisper'
    assert r.audio.model == 'small'
    assert r.audio.customModelsDir == 'C:/models'


def test_google_audio_provider_is_rejected() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        RuntimeConfigRequest.model_validate(
            {
                'activeConnectionId': 'x',
                'connections': [_CONN],
                'audio': {'provider': 'google', 'baseUrl': '', 'model': 'x', 'apiKey': ''},
            }
        )


def test_openai_audio_omitted_model_uses_transcribe_default() -> None:
    from clara_coder_backend.config import DEFAULT_TRANSCRIBE_MODEL

    r = RuntimeConfigRequest.model_validate(
        {
            'activeConnectionId': 'x',
            'connections': [_CONN],
            'audio': {'provider': 'openai', 'baseUrl': '', 'apiKey': 'sk'},
        }
    )
    assert r.audio.model == DEFAULT_TRANSCRIBE_MODEL


def test_whisper_audio_omitted_model_uses_whisper_default() -> None:
    from clara_coder_backend.config import DEFAULT_WHISPER_MODEL

    r = RuntimeConfigRequest.model_validate(
        {
            'activeConnectionId': 'x',
            'connections': [_CONN],
            'audio': {'provider': 'whisper', 'baseUrl': '', 'apiKey': ''},
        }
    )
    assert r.audio.model == DEFAULT_WHISPER_MODEL
