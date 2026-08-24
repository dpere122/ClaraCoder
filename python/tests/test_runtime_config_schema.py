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


def test_enable_agent_formatters_accepts_snake_case_string() -> None:
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
            'enable_agent_formatters': 'false',
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.enableAgentFormatters is False


def test_enable_agent_formatters_defaults_false() -> None:
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
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.enableAgentFormatters is False


def test_extra_user_path_is_accepted() -> None:
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
            'extra_user_path': '  /opt/extra  ',
        },
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.tools is not None
    assert r.tools.extraUserPath == '/opt/extra'


def test_legacy_capable_optimization_preset_maps_to_generic() -> None:
    conn = {**_CONN, 'optimizationPreset': 'capable'}
    r = RuntimeConnectionRequest.model_validate(conn)
    assert r.optimizationPreset == 'generic'


def test_audio_provider_whisper_is_accepted() -> None:
    body = {
        'activeConnectionId': 'x',
        'connections': [_CONN],
        'audio': {'provider': 'whisper', 'baseUrl': '', 'model': 'small', 'apiKey': ''},
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.audio.provider == 'whisper'


def test_audio_provider_unknown_maps_to_disabled() -> None:
    body = {
        'activeConnectionId': 'x',
        'connections': [_CONN],
        'audio': {'provider': 'not-a-real-stt', 'baseUrl': '', 'model': 'x', 'apiKey': ''},
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.audio.provider == 'disabled'


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


def test_embeddings_configured_camel_and_default() -> None:
    defaulted = RuntimeConfigRequest.model_validate(
        {
            'activeConnectionId': 'x',
            'connections': [_CONN],
            'audio': {'provider': 'openai', 'baseUrl': '', 'apiKey': ''},
        }
    )
    assert defaulted.connections[0].embeddingsConfigured is False

    body = {
        'activeConnectionId': 'x',
        'connections': [{**_CONN, 'embeddingsConfigured': True, 'embeddingsEnabled': False}],
        'audio': {'provider': 'openai', 'baseUrl': '', 'apiKey': ''},
    }
    r = RuntimeConfigRequest.model_validate(body)
    assert r.connections[0].embeddingsConfigured is True
    assert r.connections[0].embeddingsEnabled is False
