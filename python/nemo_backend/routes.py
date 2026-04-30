"""Health check and runtime configuration routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from nemo_backend.domain import RuntimeAudioConfig, RuntimeConnection, RuntimeHostConfig, RuntimeToolsConfig
from nemo_backend.schemas import RuntimeConfigRequest
from nemo_backend.checkpointing import delete_outer_threads_for_session
from nemo_backend.workspace_text_io import validate_workspace_encoding
from nemo_backend import state

logger = logging.getLogger('nemo.http.routes')

router = APIRouter()


@router.get('/health')
async def health() -> dict[str, str | bool]:
    """Liveness probe: confirms the process is up and reports active model metadata.

    ``orchestratedMode`` mirrors ``POST /runtime-config`` tools block (Settings → Tools); use it to verify the
    backend matches the UI when debugging nested ``plan_and_modify`` availability.
    """
    connection = state.get_active_connection()
    return {
        'status': 'ok',
        'provider': connection.provider,
        'model': connection.model,
        'orchestratedMode': state.runtime_config.tools.orchestrated_mode,
    }


@router.post('/runtime-config')
async def set_runtime_config(request: RuntimeConfigRequest) -> dict[str, bool]:
    """Replace LLM connections, transcription settings, and host metadata from the UI.

    Returns ``orchestratedMode`` so clients can confirm the value applied after parsing
    (handles ``orchestrated_mode`` / string ``\"true\"`` aliases). When orchestration
    toggles, LangGraph outer checkpoints for all sessions are cleared so prompts/tools
    cannot stay stuck on a prior mode.
    """
    connections = [
        RuntimeConnection(
            id=item.id,
            name=item.name,
            provider=item.provider,
            base_url=item.baseUrl,
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
            embeddings_base_url=(item.embeddingsBaseUrl or '').strip(),
            embeddings_enabled=bool(item.embeddingsEnabled),
            embeddings_model=(item.embeddingsModel or '').strip(),
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
            orchestrated_mode=request.tools.orchestratedMode,
            outer_phased_coding_cycle=request.tools.outerPhasedCodingCycle,
            allow_staging_overlay_commands=request.tools.allowStagingOverlayCommands,
        )
    else:
        tools_cfg = prev_tools

    orch_flipped = tools_cfg.orchestrated_mode != prev_tools.orchestrated_mode
    phased_flipped = tools_cfg.outer_phased_coding_cycle != prev_tools.outer_phased_coding_cycle
    if orch_flipped or phased_flipped:
        for sid in list(state.sessions.keys()):
            await delete_outer_threads_for_session(sid)
        logger.info(
            'orchestrated_mode %s -> %s, outer_phased_coding_cycle %s -> %s: cleared outer LangGraph checkpoints for %d session(s)',
            prev_tools.orchestrated_mode,
            tools_cfg.orchestrated_mode,
            prev_tools.outer_phased_coding_cycle,
            tools_cfg.outer_phased_coding_cycle,
            len(state.sessions),
        )

    # Mutate in place so modules that imported ``runtime_config`` keep seeing live values.
    cfg = state.runtime_config
    cfg.active_connection_id = active_connection_id
    cfg.connections = connections
    cfg.audio = RuntimeAudioConfig(
        provider=request.audio.provider,
        base_url=request.audio.baseUrl,
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
    logger.info(
        'POST /runtime-config applied orchestrated_mode=%s (tools payload: %s)',
        state.runtime_config.tools.orchestrated_mode,
        'yes' if request.tools is not None else 'no',
    )
    return {
        'ok': True,
        'orchestratedMode': state.runtime_config.tools.orchestrated_mode,
        'outerPhasedCodingCycle': state.runtime_config.tools.outer_phased_coding_cycle,
    }
