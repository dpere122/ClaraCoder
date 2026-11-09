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
    import os

    from clara_coder_backend.main import app
    from clara_coder_backend.session import state
    from clara_coder_backend.llm import messages
    from clara_coder_backend.llm import model_tuning
    orig = deepcopy(state.runtime_config)
    orig_path = os.environ.get('PATH', '')
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

            r4_body = _payload()
            r4_body['tools']['extraUserPath'] = '/opt/clara-extra'
            r4 = client.post('/runtime-config', json=r4_body)
            assert r4.status_code == 200
            assert state.runtime_config.tools.extra_user_path == '/opt/clara-extra'
            assert '/opt/clara-extra' in os.environ['PATH'].split(os.pathsep)

            r5_body = _payload()
            r5_body['tools']['enableAgentFormatters'] = False
            r5 = client.post('/runtime-config', json=r5_body)
            assert r5.status_code == 200
            assert state.runtime_config.tools.enable_agent_formatters is False
            assert messages.runtime_config.tools.enable_agent_formatters is False
    finally:
        os.environ['PATH'] = orig_path
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools


def test_runtime_config_passes_server_vision_through() -> None:
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    orig = deepcopy(state.runtime_config)
    body = _payload()
    caps = {'enableThinking': True, 'reasoningEffortValues': None, 'vision': False}
    body['connections'][0]['chatTemplateReasoning'] = caps
    try:
        with TestClient(app) as client:
            assert client.post('/runtime-config', json=body).status_code == 200
            assert state.get_active_connection().chat_template_reasoning['vision'] is False

            del caps['vision']
            assert client.post('/runtime-config', json=body).status_code == 200
            assert state.get_active_connection().chat_template_reasoning['vision'] is None
    finally:
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools


def test_runtime_config_applies_whisper_custom_models_dir() -> None:
    import os

    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    orig = deepcopy(state.runtime_config)
    orig_models = os.environ.get('CLARA_CUSTOM_MODELS_DIR')
    body = _payload()
    body['audio'] = {
        'provider': 'whisper',
        'baseUrl': '',
        'model': 'tiny',
        'apiKey': '',
        'customModelsDir': '/tmp/clara-models',
    }
    try:
        with TestClient(app) as client:
            r = client.post('/runtime-config', json=body)
        assert r.status_code == 200
        assert state.runtime_config.audio.provider == 'whisper'
        assert state.runtime_config.audio.model == 'tiny'
        assert state.runtime_config.audio.custom_models_dir == '/tmp/clara-models'
        assert os.environ.get('CLARA_CUSTOM_MODELS_DIR') == '/tmp/clara-models'
    finally:
        if orig_models is None:
            os.environ.pop('CLARA_CUSTOM_MODELS_DIR', None)
        else:
            os.environ['CLARA_CUSTOM_MODELS_DIR'] = orig_models
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools


def test_runtime_config_clears_custom_models_dir_when_empty() -> None:
    import os

    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    orig = deepcopy(state.runtime_config)
    orig_models = os.environ.get('CLARA_CUSTOM_MODELS_DIR')
    os.environ['CLARA_CUSTOM_MODELS_DIR'] = '/tmp/stale-models'
    body = _payload()
    body['audio'] = {
        'provider': 'whisper',
        'baseUrl': '',
        'model': 'tiny',
        'apiKey': '',
        'customModelsDir': '',
    }
    try:
        with TestClient(app) as client:
            r = client.post('/runtime-config', json=body)
        assert r.status_code == 200
        assert state.runtime_config.audio.custom_models_dir == ''
        assert 'CLARA_CUSTOM_MODELS_DIR' not in os.environ
    finally:
        if orig_models is None:
            os.environ.pop('CLARA_CUSTOM_MODELS_DIR', None)
        else:
            os.environ['CLARA_CUSTOM_MODELS_DIR'] = orig_models
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools


def test_runtime_config_stores_embeddings_configured() -> None:
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    orig = deepcopy(state.runtime_config)
    body = _payload()
    body['connections'][0]['embeddingsEnabled'] = False
    body['connections'][0]['embeddingsConfigured'] = True
    try:
        with TestClient(app) as client:
            r = client.post('/runtime-config', json=body)
        assert r.status_code == 200
        conn = state.runtime_config.connections[0]
        assert conn.embeddings_configured is True
        assert conn.embeddings_enabled is False
    finally:
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools


def test_runtime_config_applies_hugging_face_token() -> None:
    import os

    from clara_coder_backend.main import app
    from clara_coder_backend.session import state

    orig = deepcopy(state.runtime_config)
    orig_hf = os.environ.get('HF_TOKEN')
    orig_hub = os.environ.get('HUGGING_FACE_HUB_TOKEN')
    body = _payload()
    body['huggingFaceToken'] = 'hf_test_token'
    try:
        with TestClient(app) as client:
            r = client.post('/runtime-config', json=body)
        assert r.status_code == 200
        assert os.environ.get('HF_TOKEN') == 'hf_test_token'
        assert os.environ.get('HUGGING_FACE_HUB_TOKEN') == 'hf_test_token'
    finally:
        if orig_hf is None:
            os.environ.pop('HF_TOKEN', None)
        else:
            os.environ['HF_TOKEN'] = orig_hf
        if orig_hub is None:
            os.environ.pop('HUGGING_FACE_HUB_TOKEN', None)
        else:
            os.environ['HUGGING_FACE_HUB_TOKEN'] = orig_hub
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.connections = orig.connections
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        state.runtime_config.tools = orig.tools


def test_runtime_config_applies_python_lsp_settings_and_restarts_basedpyright_only_when_they_change(
    monkeypatch,
) -> None:
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state
    from clara_coder_backend.lsp import manager as lsp_manager

    stopped: list[str] = []
    monkeypatch.setattr(lsp_manager, 'shutdown_lsp_server_for_all_sessions', stopped.append)
    orig = deepcopy(state.runtime_config)
    settings = {
        'typeCheckingMode': 'recommended',
        'diagnosticMode': 'workspace',
        'inlayVariableTypes': False,
        'inlayCallArgumentNames': True,
        'inlayFunctionReturnTypes': False,
        'inlayGenericTypes': True,
        'autoImportCompletions': False,
        'extraPaths': [' src ', '', 'src', 'libs'],
    }
    try:
        with TestClient(app) as client:
            assert client.post('/runtime-config', json=_payload()).status_code == 200
            stopped.clear()

            body = {**_payload(), 'lsp': {'python': settings}}
            assert client.post('/runtime-config', json=body).status_code == 200
            applied = state.runtime_config.lsp.python
            assert applied.type_checking_mode == 'recommended'
            assert applied.diagnostic_mode == 'workspace'
            assert applied.inlay_variable_types is False
            assert applied.inlay_generic_types is True
            assert applied.auto_import_completions is False
            assert applied.extra_paths == ['src', 'libs'], 'trimmed, blanks and repeats dropped'
            assert stopped == ['python']

            assert client.post('/runtime-config', json=body).status_code == 200
            assert stopped == ['python'], 'saving unchanged settings must not restart basedpyright'

            bad = {**_payload(), 'lsp': {'python': {**settings, 'typeCheckingMode': 'loud'}}}
            assert client.post('/runtime-config', json=bad).status_code == 422
    finally:
        state.runtime_config.lsp = orig.lsp
        state.runtime_config.tools = orig.tools
        state.runtime_config.connections = orig.connections
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host


def test_runtime_config_applies_typescript_lsp_settings_and_restarts_vtsls_only_when_they_change(
    monkeypatch,
) -> None:
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state
    from clara_coder_backend.lsp import manager as lsp_manager

    stopped: list[str] = []
    monkeypatch.setattr(lsp_manager, 'shutdown_lsp_server_for_all_sessions', stopped.append)
    orig = deepcopy(state.runtime_config)
    settings = {
        'useWorkspaceTsdk': True,
        'validateJavaScript': False,
        'checkJs': True,
        'inlayParameterNames': 'literals',
        'inlayParameterTypes': True,
        'inlayVariableTypes': True,
        'inlayPropertyDeclarationTypes': False,
        'inlayFunctionReturnTypes': True,
        'inlayEnumMemberValues': True,
        'autoImportCompletions': False,
        'importModuleSpecifier': 'project-relative',
        'quoteStyle': 'double',
    }
    try:
        with TestClient(app) as client:
            assert client.post('/runtime-config', json=_payload()).status_code == 200
            stopped.clear()

            body = {**_payload(), 'lsp': {'typescript': settings}}
            assert client.post('/runtime-config', json=body).status_code == 200
            applied = state.runtime_config.lsp.typescript
            assert applied.use_workspace_tsdk is True
            assert applied.validate_javascript is False
            assert applied.check_js is True
            assert applied.inlay_parameter_names == 'literals'
            assert applied.inlay_property_declaration_types is False
            assert applied.inlay_enum_member_values is True
            assert applied.auto_import_completions is False
            assert applied.import_module_specifier == 'project-relative'
            assert applied.quote_style == 'double'
            assert stopped == ['typescript']

            assert client.post('/runtime-config', json=body).status_code == 200
            assert stopped == ['typescript'], 'saving unchanged settings must not restart vtsls'

            for field, value in (('inlayParameterNames', 'some'), ('quoteStyle', 'backtick')):
                bad = {**_payload(), 'lsp': {'typescript': {**settings, field: value}}}
                assert client.post('/runtime-config', json=bad).status_code == 422
    finally:
        state.runtime_config.lsp = orig.lsp
        state.runtime_config.tools = orig.tools
        state.runtime_config.connections = orig.connections
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host


def test_runtime_config_applies_java_lsp_settings_and_restarts_jdt_ls_only_when_they_change(monkeypatch) -> None:
    from clara_coder_backend.main import app
    from clara_coder_backend.session import state
    from clara_coder_backend.lsp import manager as lsp_manager

    stopped: list[str] = []
    monkeypatch.setattr(lsp_manager, 'shutdown_lsp_server_for_all_sessions', stopped.append)
    orig = deepcopy(state.runtime_config)
    settings = {
        'jdkHome': ' C:/jdk-21 ',
        'maxHeap': '4G',
        'runtimes': [
            {'name': ' JavaSE-17 ', 'path': ' C:/jdk-17 '},
            {'name': 'JavaSE-11', 'path': ' '},
        ],
        'importMaven': False,
        'importGradle': True,
        'projectMetadataAtRoot': False,
        'mavenUserSettings': ' C:/m2/settings.xml ',
        'updateBuildConfiguration': 'disabled',
        'autobuild': False,
        'inlayParameterNames': 'all',
        'inlayVariableTypes': True,
        'inlayParameterTypes': False,
        'inlayFormatParameters': True,
        'referencesCodeLens': False,
        'implementationCodeLens': 'methods',
        'signatureHelp': False,
        'guessMethodArguments': 'insertBestGuessedArguments',
        'formatEnabled': True,
        'formatOnType': True,
        'formatComments': False,
        'formatterSettingsPath': ' C:/style.xml ',
        'formatterProfile': ' Team ',
    }
    try:
        with TestClient(app) as client:
            assert client.post('/runtime-config', json=_payload()).status_code == 200
            stopped.clear()

            body = {**_payload(), 'lsp': {'java': settings}}
            assert client.post('/runtime-config', json=body).status_code == 200
            applied = state.runtime_config.lsp.java
            assert applied.jdk_home == 'C:/jdk-21'
            assert applied.max_heap == '4G'
            assert applied.runtimes == [('JavaSE-17', 'C:/jdk-17')], 'trimmed, incomplete entries dropped'
            assert applied.import_maven is False
            assert applied.project_metadata_at_root is False
            assert applied.maven_user_settings == 'C:/m2/settings.xml'
            assert applied.update_build_configuration == 'disabled'
            assert applied.autobuild is False
            assert applied.inlay_parameter_names == 'all'
            assert applied.implementation_code_lens == 'methods'
            assert applied.signature_help is False
            assert applied.guess_method_arguments == 'insertBestGuessedArguments'
            assert applied.format_on_type is True
            assert applied.formatter_settings_path == 'C:/style.xml'
            assert applied.formatter_profile == 'Team'
            assert stopped == ['java']

            assert client.post('/runtime-config', json=body).status_code == 200
            assert stopped == ['java'], 'saving unchanged settings must not restart JDT LS'

            for field, value in (
                ('maxHeap', '1T'),
                ('updateBuildConfiguration', 'interactive'),
                ('inlayParameterNames', 'some'),
                ('implementationCodeLens', 'everything'),
                ('guessMethodArguments', 'auto'),
            ):
                bad = {**_payload(), 'lsp': {'java': {**settings, field: value}}}
                assert client.post('/runtime-config', json=bad).status_code == 422
    finally:
        state.runtime_config.lsp = orig.lsp
        state.runtime_config.tools = orig.tools
        state.runtime_config.connections = orig.connections
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host


def test_runtime_config_applies_lsp_settings_and_restarts_gdls_only_when_they_change(monkeypatch) -> None:
    import os

    from clara_coder_backend.main import app
    from clara_coder_backend.session import state
    from clara_coder_backend.lsp import manager as lsp_manager
    from clara_coder_backend.lsp.plugins import gdscript_plugin

    stopped: list[str] = []
    monkeypatch.setattr(lsp_manager, 'shutdown_lsp_server_for_all_sessions', stopped.append)
    orig = deepcopy(state.runtime_config)
    orig_path = os.environ.get('PATH', '')
    settings = {
        'godotBinaryPath': ' C:/godot/godot.exe ',
        'allowEngineApiDump': True,
        'diagnosticsProfile': 'strict',
        'inlayTypeHints': False,
        'inlayParameterHints': True,
        'formatterCommand': 'fmt',
        'formatterArgs': '--stdin',
    }
    try:
        with TestClient(app) as client:
            assert client.post('/runtime-config', json=_payload()).status_code == 200
            before = state.runtime_config.lsp
            assert stopped == [], 'a payload without lsp settings keeps what is there'

            body = {**_payload(), 'lsp': {'gdscript': settings}}
            assert client.post('/runtime-config', json=body).status_code == 200
            applied = state.runtime_config.lsp.gdscript
            assert applied.godot_binary_path == 'C:/godot/godot.exe'
            assert applied.allow_engine_api_dump is True
            assert applied.diagnostics_profile == 'strict'
            assert applied.inlay_type_hints is False
            assert applied.formatter_args == '--stdin'
            assert gdscript_plugin.runtime_config.lsp.gdscript is applied, 'importers see live values'
            assert before.gdscript is not applied
            assert stopped == ['gdscript']

            assert client.post('/runtime-config', json=body).status_code == 200
            assert stopped == ['gdscript'], 'saving unrelated settings must not restart gdls'

            bad = {**_payload(), 'lsp': {'gdscript': {**settings, 'diagnosticsProfile': 'loud'}}}
            assert client.post('/runtime-config', json=bad).status_code == 422
    finally:
        state.runtime_config.lsp = orig.lsp
        state.runtime_config.tools = orig.tools
        state.runtime_config.connections = orig.connections
        state.runtime_config.active_connection_id = orig.active_connection_id
        state.runtime_config.audio = orig.audio
        state.runtime_config.host = orig.host
        os.environ['PATH'] = orig_path
