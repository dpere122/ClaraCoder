"""Health check and runtime configuration routes."""

from __future__ import annotations

import hashlib
import logging
import os

from fastapi import APIRouter, HTTPException

from clara_coder_backend.domain import (
    RuntimeAudioConfig,
    RuntimeConnection,
    RuntimeContextCompressionConfig,
    RuntimeHostConfig,
    RuntimeToolsConfig,
)
from clara_coder_backend.runtime.http_url_normalize import normalize_bind_all_host_url
from clara_coder_backend.runtime.python_env import apply_extra_user_path
from clara_coder_backend.session.schemas import ChatTemplateReasoningCapsRequest, RuntimeConfigRequest
from clara_coder_backend.workspace.workspace_text_io import validate_workspace_encoding
from clara_coder_backend.session import state
logger = logging.getLogger('clara.http.routes')

router = APIRouter()


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
    }


def _sidecar_marker() -> str:
    """First 16 hex chars of sha256(CLARA_SIDECAR_TOKEN) — Electron confirms this listener is ours."""
    token = os.getenv('CLARA_SIDECAR_TOKEN', '') or ''
    if not token:
        return ''
    return hashlib.sha256(token.encode('utf-8')).hexdigest()[:16]


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
    """Report CPU Nomic embeddings load status for the status-bar indicator.

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
            extra_user_path=(request.tools.extraUserPath or '').strip(),
            enable_agent_formatters=request.tools.enableAgentFormatters,
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
    apply_extra_user_path(tools_cfg.extra_user_path)
    logger.info(
        'POST /runtime-config applied (tools payload: %s, contextCompression: %s)',
        'yes' if request.tools is not None else 'no',
        'yes' if request.contextCompression is not None else 'no',
    )

    # Preload CPU Nomic embeddings as soon as the chat model is connected.
    active_conn = state.get_active_connection()
    try:
        from clara_coder_backend.workspace_index.embeddings_factory import preload_embedding_model
        preload_embedding_model(active_conn)
    except Exception:
        logger.debug('embeddings preload trigger failed', exc_info=True)

    return {'ok': True}
