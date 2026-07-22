"""Health check and runtime configuration routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from nemo_backend.domain import (
    RuntimeAudioConfig,
    RuntimeConnection,
    RuntimeContextCompressionConfig,
    RuntimeHostConfig,
    RuntimeToolsConfig,
)
from nemo_backend.http_url_normalize import normalize_bind_all_host_url
from nemo_backend.schemas import RuntimeConfigRequest
from nemo_backend.workspace_text_io import validate_workspace_encoding
from nemo_backend import state

logger = logging.getLogger('nemo.http.routes')

router = APIRouter()


@router.get('/health')
async def health() -> dict[str, str | bool]:
    """Liveness probe: confirms the process is up and reports active model metadata."""
    connection = state.get_active_connection()
    return {
        'status': 'ok',
        'provider': connection.provider,
        'model': connection.model,
    }


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
            plan_retry_attempts_count=int(item.planRetryAttemptsCount),
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
            context_window_tokens=int(item.contextWindowTokens),
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
            protect_tail_messages=int(cc_req.protectTailMessages),
            recent_tool_body_max_chars=int(cc_req.recentToolBodyMaxChars),
            old_tool_body_max_chars=int(cc_req.oldToolBodyMaxChars),
            system_reserve_ratio=float(cc_req.systemReserveRatio),
        )
    else:
        context_compression_cfg = prev_cc

    # Mutate in place so modules that imported ``runtime_config`` keep seeing live values.
    cfg = state.runtime_config
    cfg.active_connection_id = active_connection_id
    cfg.connections = connections
    cfg.audio = RuntimeAudioConfig(
        provider=request.audio.provider,
        base_url=normalize_bind_all_host_url(request.audio.baseUrl),
        model=request.audio.model,
        api_key=request.audio.apiKey,
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
    logger.info(
        'POST /runtime-config applied (tools payload: %s, contextCompression: %s)',
        'yes' if request.tools is not None else 'no',
        'yes' if request.contextCompression is not None else 'no',
    )
    return {'ok': True}
