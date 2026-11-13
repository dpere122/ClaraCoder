"""Health check and runtime configuration routes."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os

from fastapi import APIRouter, HTTPException

from clara_coder_backend.domain import (
    RuntimeAudioConfig,
    RuntimeConnection,
    RuntimeContextCompressionConfig,
    RuntimeGdscriptLspConfig,
    RuntimeHostConfig,
    RuntimeJavaLspConfig,
    RuntimeLspConfig,
    RuntimeMcpServer,
    RuntimePythonLspConfig,
    RuntimeRustLspConfig,
    RuntimeSubagentRole,
    RuntimeSubagentsConfig,
    RuntimeToolsConfig,
    SUBAGENT_THINKING_LEVELS,
    SUBAGENT_TOOL_GROUPS,
    RuntimeTypescriptLspConfig,
)
from clara_coder_backend.runtime.http_url_normalize import normalize_bind_all_host_url
from clara_coder_backend.runtime.python_env import apply_extra_user_path
from clara_coder_backend.session.schemas import (
    ChatTemplateReasoningCapsRequest,
    RuntimeConfigRequest,
    RuntimeLspRequest,
    RuntimeSubagentsRequest,
)
from clara_coder_backend.workspace.workspace_text_io import validate_workspace_encoding
from clara_coder_backend.session import state
logger = logging.getLogger('clara.http.routes')

router = APIRouter()


def _runtime_lsp_config(request: RuntimeLspRequest) -> RuntimeLspConfig:
    g = request.gdscript
    p = request.python
    t = request.typescript
    j = request.java
    r = request.rust
    return RuntimeLspConfig(
        gdscript=RuntimeGdscriptLspConfig(
            godot_binary_path=g.godotBinaryPath.strip(),
            allow_engine_api_dump=g.allowEngineApiDump,
            diagnostics_profile=g.diagnosticsProfile,
            inlay_type_hints=g.inlayTypeHints,
            inlay_parameter_hints=g.inlayParameterHints,
            formatter_command=g.formatterCommand.strip(),
            formatter_args=g.formatterArgs.strip(),
        ),
        python=RuntimePythonLspConfig(
            type_checking_mode=p.typeCheckingMode,
            diagnostic_mode=p.diagnosticMode,
            inlay_variable_types=p.inlayVariableTypes,
            inlay_call_argument_names=p.inlayCallArgumentNames,
            inlay_function_return_types=p.inlayFunctionReturnTypes,
            inlay_generic_types=p.inlayGenericTypes,
            auto_import_completions=p.autoImportCompletions,
            extra_paths=list(dict.fromkeys(path.strip() for path in p.extraPaths if path.strip())),
        ),
        typescript=RuntimeTypescriptLspConfig(
            use_workspace_tsdk=t.useWorkspaceTsdk,
            validate_javascript=t.validateJavaScript,
            check_js=t.checkJs,
            inlay_parameter_names=t.inlayParameterNames,
            inlay_parameter_types=t.inlayParameterTypes,
            inlay_variable_types=t.inlayVariableTypes,
            inlay_property_declaration_types=t.inlayPropertyDeclarationTypes,
            inlay_function_return_types=t.inlayFunctionReturnTypes,
            inlay_enum_member_values=t.inlayEnumMemberValues,
            auto_import_completions=t.autoImportCompletions,
            import_module_specifier=t.importModuleSpecifier,
            quote_style=t.quoteStyle,
        ),
        java=RuntimeJavaLspConfig(
            jdk_home=j.jdkHome.strip(),
            max_heap=j.maxHeap,
            runtimes=[
                (runtime.name.strip(), runtime.path.strip())
                for runtime in j.runtimes
                if runtime.name.strip() and runtime.path.strip()
            ],
            import_maven=j.importMaven,
            import_gradle=j.importGradle,
            project_metadata_at_root=j.projectMetadataAtRoot,
            maven_user_settings=j.mavenUserSettings.strip(),
            update_build_configuration=j.updateBuildConfiguration,
            autobuild=j.autobuild,
            inlay_parameter_names=j.inlayParameterNames,
            inlay_variable_types=j.inlayVariableTypes,
            inlay_parameter_types=j.inlayParameterTypes,
            inlay_format_parameters=j.inlayFormatParameters,
            references_code_lens=j.referencesCodeLens,
            implementation_code_lens=j.implementationCodeLens,
            signature_help=j.signatureHelp,
            guess_method_arguments=j.guessMethodArguments,
            format_enabled=j.formatEnabled,
            format_on_type=j.formatOnType,
            format_comments=j.formatComments,
            formatter_settings_path=j.formatterSettingsPath.strip(),
            formatter_profile=j.formatterProfile.strip(),
        ),
        rust=RuntimeRustLspConfig(
            run_build_scripts=r.runBuildScripts,
            expand_proc_macros=r.expandProcMacros,
            check_on_save=r.checkOnSave,
            check_command=r.checkCommand,
            separate_target_dir=r.separateTargetDir,
            all_features=r.allFeatures,
            inlay_type_hints=r.inlayTypeHints,
            inlay_parameter_hints=r.inlayParameterHints,
            inlay_chaining_hints=r.inlayChainingHints,
        ),
    )


def _chat_template_reasoning_dict(
    caps: ChatTemplateReasoningCapsRequest | None,
) -> dict[str, object] | None:
    if caps is None:
        return None
    return {
        'enableThinking': bool(caps.enableThinking),
        'reasoningEffortValues': (
            list(caps.reasoningEffortValues) if caps.reasoningEffortValues is not None else None
        ),
        'adaptiveThinking': bool(caps.adaptiveThinking),
        'vision': caps.vision,
    }


def _runtime_mcp_server(item: object) -> RuntimeMcpServer:
    oauth = getattr(item, 'oauth', None)
    decisions = dict(getattr(item, 'toolDecisions', None) or {})
    return RuntimeMcpServer(
        id=str(getattr(item, 'id', '') or '').strip(),
        name=str(getattr(item, 'name', '') or '').strip(),
        enabled=bool(getattr(item, 'enabled', False)),
        trust='allow-all' if getattr(item, 'trust', '') == 'allow-all' else 'ask',
        transport='http' if getattr(item, 'transport', '') == 'http' else 'stdio',
        command=str(getattr(item, 'command', '') or ''),
        args=[str(arg) for arg in (getattr(item, 'args', None) or [])],
        env=[(entry.key, entry.value) for entry in (getattr(item, 'env', None) or []) if str(entry.key).strip()],
        url=str(getattr(item, 'url', '') or '').strip(),
        http_transport='sse' if getattr(item, 'httpTransport', '') == 'sse' else 'streamable',
        http_auth=str(getattr(item, 'httpAuth', '') or 'none'),
        headers=[
            (entry.key, entry.value) for entry in (getattr(item, 'headers', None) or []) if str(entry.key).strip()
        ],
        oauth_access_token=str(getattr(oauth, 'accessToken', '') or '') if oauth else '',
        oauth_refresh_token=str(getattr(oauth, 'refreshToken', '') or '') if oauth else '',
        oauth_expires_at=float(getattr(oauth, 'expiresAt', 0) or 0) if oauth else 0,
        oauth_client_id=str(getattr(oauth, 'clientId', '') or '') if oauth else '',
        oauth_client_secret=str(getattr(oauth, 'clientSecret', '') or '') if oauth else '',
        oauth_scopes=[str(scope) for scope in (getattr(oauth, 'scopes', None) or [])] if oauth else [],
        oauth_server_url=str(getattr(oauth, 'serverUrl', '') or '').strip() if oauth else '',
        tool_decisions={str(key): str(value) for key, value in decisions.items() if value in ('allow', 'deny')},
    )


def _sidecar_marker() -> str:
    """First 16 hex chars of sha256(CLARA_SIDECAR_TOKEN) — Electron confirms this listener is ours."""
    token = os.getenv('CLARA_SIDECAR_TOKEN', '') or ''
    if not token:
        return ''
    return hashlib.sha256(token.encode('utf-8')).hexdigest()[:16]


def _runtime_subagents_config(request: RuntimeSubagentsRequest) -> RuntimeSubagentsConfig:
    """Settings roles as the runtime keeps them: named, unique by name, known tool groups only."""
    roles: list[RuntimeSubagentRole] = []
    seen: set[str] = set()
    for item in request.roles:
        name = ' '.join((item.name or '').split())
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        roles.append(
            RuntimeSubagentRole(
                id=(item.id or '').strip() or name,
                name=name,
                description=(item.description or '').strip(),
                enabled=bool(item.enabled),
                connection_id=(item.connectionId or '').strip(),
                model=(item.model or '').strip(),
                read_only=bool(item.readOnly),
                thinking='' if item.thinking == 'source' else item.thinking,
                thinking_level=item.thinkingLevel if item.thinkingLevel in SUBAGENT_THINKING_LEVELS else '',
                tool_groups=frozenset(group for group in item.tools if group in SUBAGENT_TOOL_GROUPS),
                instructions=(item.instructions or '').strip(),
            )
        )
    return RuntimeSubagentsConfig(
        enabled=bool(request.enabled),
        cloud_concurrency=int(request.cloudConcurrency),
        fallback=request.fallback,
        roles=roles,
    )


@router.get('/health')
async def health() -> dict[str, str | bool]:
    """Liveness probe: confirms the process is up and reports active model metadata."""
    connection = state.get_active_connection()
    return {
        'status': 'ok',
        'provider': connection.provider,
        'model': connection.model,
        'x_clara_sidecar': _sidecar_marker(),
    }


@router.get('/embeddings/status')
async def embeddings_status() -> dict[str, str]:
    """Report CPU embeddings load status for the status-bar indicator.

    Returns ``status`` in ``idle`` | ``loading`` | ``ready`` | ``error`` | ``disabled``,
    plus the pinned ``model`` id.

    When the main chat model is disconnected or not running, the embeddings model is
    considered inactive (``idle``) even if the ONNX engine was previously loaded — the
    indicator shows red and semantic index calls are skipped.
    """
    from clara_coder_backend.config import CLARA_EMBEDDINGS_CPU_ENABLED
    from clara_coder_backend.workspace_index.embeddings_factory import chat_connected
    from clara_coder_backend.workspace_index.fastembed_backend import fastembed_model_id, get_embed_status

    if not CLARA_EMBEDDINGS_CPU_ENABLED:
        return {'status': 'disabled', 'model': fastembed_model_id()}

    conn = state.get_active_connection()
    chat_ok, _ = chat_connected(conn)
    if not chat_ok:
        return {'status': 'idle', 'model': fastembed_model_id()}

    return {'status': get_embed_status(), 'model': fastembed_model_id()}


@router.post('/runtime-config')
async def set_runtime_config(request: RuntimeConfigRequest) -> dict[str, bool]:
    """Replace LLM connections, transcription settings, and host metadata from the UI."""
    connections = [
        RuntimeConnection(
            id=item.id,
            name=item.name,
            provider=item.provider,
            base_url=normalize_bind_all_host_url(item.baseUrl),
            model=item.model,
            api_key=item.apiKey,
            reasoning_effort=(item.reasoningEffort or '').strip(),
            temperature=float(item.temperature),
            parallel_tool_calls=bool(item.parallelToolCalls),
            optimization_preset=item.optimizationPreset,
            max_output_tokens=int(item.maxOutputTokens),
            thinking_mode=item.thinkingMode,
            sampling_preset=item.samplingPreset,
            top_p=item.topP,
            top_k=item.topK,
            min_p=item.minP,
            presence_penalty=item.presencePenalty,
            repeat_penalty=item.repeatPenalty,
            architecture_hint=item.architectureHint,
            embeddings_base_url=normalize_bind_all_host_url((item.embeddingsBaseUrl or '').strip()),
            embeddings_enabled=bool(item.embeddingsEnabled),
            embeddings_model=(item.embeddingsModel or '').strip(),
            embeddings_configured=bool(item.embeddingsConfigured),
            context_window_tokens=int(item.contextWindowTokens),
            idle_ttl_seconds=int(item.idleTtlSeconds),
            open_ai_compat=item.openAiCompat.model_dump() if item.openAiCompat else None,
            custom_headers=dict(item.customHeaders),
            chat_template_reasoning=_chat_template_reasoning_dict(item.chatTemplateReasoning),
        )
        for item in request.connections
    ]
    if not connections:
        raise HTTPException(status_code=400, detail='At least one LLM connection is required.')

    active_connection_id = request.activeConnectionId
    if not any(connection.id == active_connection_id for connection in connections):
        active_connection_id = connections[0].id

    prev_tools = state.runtime_config.tools
    if request.tools is not None:
        try:
            default_enc = validate_workspace_encoding(request.tools.defaultWorkspaceEncoding)
        except ValueError:
            default_enc = 'utf-8'
        nl = request.tools.defaultWorkspaceNewline
        if nl not in ('lf', 'crlf', 'preserve'):
            nl = 'lf'
        tools_cfg = RuntimeToolsConfig(
            edit_tools_strict=request.tools.editToolsStrict,
            max_file_read_lines=request.tools.maxFileReadLines,
            max_search_results=request.tools.maxSearchResults,
            default_workspace_encoding=default_enc,
            default_workspace_newline=nl,
            allow_staging_overlay_commands=request.tools.allowStagingOverlayCommands,
            command_line_explain_step=request.tools.commandLineExplainStep,
            expose_all_workspace_files=request.tools.exposeAllWorkspaceFiles,
            allow_web_access=request.tools.allowWebAccess,
            searxng_base_url=(request.tools.searxngBaseUrl or '').strip().rstrip('/'),
            web_search_provider=request.tools.webSearchProvider,
            web_search_engines=list(request.tools.webSearchEngines),
            web_search_user_agent=request.tools.webSearchUserAgent,
            web_search_cooldown_seconds=request.tools.webSearchCooldownSeconds,
            extra_user_path=(request.tools.extraUserPath or '').strip(),
            enable_agent_formatters=request.tools.enableAgentFormatters,
            verify_after_edits=request.tools.verifyAfterEdits,
            verify_max_fix_rounds=request.tools.verifyMaxFixRounds,
        )
    else:
        tools_cfg = prev_tools

    prev_cc = state.runtime_config.context_compression
    if request.contextCompression is not None:
        cc_req = request.contextCompression
        context_compression_cfg = RuntimeContextCompressionConfig(
            enabled=bool(cc_req.enabled),
            trigger_ratio=float(cc_req.triggerRatio),
            target_ratio=float(cc_req.targetRatio),
        )
    else:
        context_compression_cfg = prev_cc

    prev_lsp = state.runtime_config.lsp
    lsp_cfg = _runtime_lsp_config(request.lsp) if request.lsp is not None else prev_lsp

    token = (request.huggingFaceToken or '').strip()
    if token:
        os.environ['HF_TOKEN'] = token
        os.environ['HUGGING_FACE_HUB_TOKEN'] = token
    else:
        os.environ.pop('HF_TOKEN', None)
        os.environ.pop('HUGGING_FACE_HUB_TOKEN', None)

    models_dir = (request.audio.customModelsDir or '').strip()
    if models_dir:
        os.environ['CLARA_CUSTOM_MODELS_DIR'] = models_dir
    else:
        os.environ.pop('CLARA_CUSTOM_MODELS_DIR', None)

    # Mutate in place so modules that imported ``runtime_config`` keep seeing live values.
    cfg = state.runtime_config
    cfg.active_connection_id = active_connection_id
    cfg.connections = connections
    cfg.audio = RuntimeAudioConfig(
        provider=request.audio.provider,
        base_url=normalize_bind_all_host_url(request.audio.baseUrl),
        model=request.audio.model,
        api_key=request.audio.apiKey,
        custom_models_dir=(request.audio.customModelsDir or '').strip(),
    )
    cfg.host = RuntimeHostConfig(
        platform=request.host.platform if request.host else '',
        release=request.host.release if request.host else '',
        arch=request.host.arch if request.host else '',
        version=request.host.version if request.host else '',
        label=request.host.label if request.host else '',
    )
    cfg.tools = tools_cfg
    cfg.context_compression = context_compression_cfg
    cfg.lsp = lsp_cfg
    if request.subagents is not None:
        cfg.subagents = _runtime_subagents_config(request.subagents)
    prev_trusted = cfg.trusted_workspace_keys
    if request.trustedWorkspacePaths is not None:
        from clara_coder_backend.workspace.trust import trusted_workspace_keys

        cfg.trusted_workspace_keys = trusted_workspace_keys(request.trustedWorkspacePaths)
    state.runtime_config_received.set()
    cfg.mcp_servers = [_runtime_mcp_server(item) for item in request.mcpServers]
    cfg.active_workspace_path = (request.activeWorkspacePath or '').strip()
    apply_extra_user_path(tools_cfg.extra_user_path)
    if lsp_cfg.gdscript != prev_lsp.gdscript:
        # gdls reads these when it starts; the next request for a ``.gd`` file starts it again.
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        await asyncio.to_thread(shutdown_lsp_server_for_all_sessions, 'gdscript')
    if lsp_cfg.python != prev_lsp.python:
        # Some basedpyright settings (diagnostic scope, type checking mode) only take full effect on a
        # fresh start, so restart it; the next request for a ``.py`` file starts it again.
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        await asyncio.to_thread(shutdown_lsp_server_for_all_sessions, 'python')
    if lsp_cfg.typescript != prev_lsp.typescript:
        # vtsls takes most of these live, but it only republishes diagnostics that change, and a
        # tsserver change (workspace TypeScript, checkJs) is cleaner on a fresh start. The next
        # request for a TS/JS file starts it again.
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        await asyncio.to_thread(shutdown_lsp_server_for_all_sessions, 'typescript')
    if lsp_cfg.java != prev_lsp.java:
        # The JDK and heap are launch arguments, and import settings only apply when JDT LS opens the
        # project, so restart it; the next request for a ``.java`` file starts it again.
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        await asyncio.to_thread(shutdown_lsp_server_for_all_sessions, 'java')
    restarted = {
        server_id
        for server_id in ('gdscript', 'python', 'typescript', 'java')
        if getattr(lsp_cfg, server_id) != getattr(prev_lsp, server_id)
    }
    if lsp_cfg.rust != prev_lsp.rust:
        # rust-analyzer could take these live, but a build-script or check change is cleaner on a
        # fresh project load; the next request for a ``.rs`` file starts it again.
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions

        await asyncio.to_thread(shutdown_lsp_server_for_all_sessions, 'rust')
        restarted.add('rust')
    if cfg.trusted_workspace_keys != prev_trusted:
        # A server that reads workspace trust reads it when it starts, so a workspace that lost
        # trust must not keep the server it had.
        from clara_coder_backend.lsp.manager import shutdown_lsp_server_for_all_sessions
        from clara_coder_backend.lsp.registry import workspace_trust_lsp_server_ids

        for server_id in workspace_trust_lsp_server_ids():
            if server_id not in restarted:
                await asyncio.to_thread(shutdown_lsp_server_for_all_sessions, server_id)
    try:
        from clara_coder_backend.mcp.manager import schedule_mcp_reconcile

        schedule_mcp_reconcile()
    except Exception:
        logger.debug('mcp reconcile schedule failed', exc_info=True)
    logger.info(
        'POST /runtime-config applied (tools payload: %s, contextCompression: %s)',
        'yes' if request.tools is not None else 'no',
        'yes' if request.contextCompression is not None else 'no',
    )

    # Preload CPU FastEmbed embeddings as soon as the chat model is connected.
    active_conn = state.get_active_connection()
    try:
        from clara_coder_backend.workspace_index.embeddings_factory import preload_embedding_model
        preload_embedding_model(active_conn)
    except Exception:
        logger.debug('embeddings preload trigger failed', exc_info=True)

    return {'ok': True}
