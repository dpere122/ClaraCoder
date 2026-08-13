"""Process-wide env-backed constants and limits.

Leaf module: no imports from ``session``, ``domain``, or feature packages.

Environment keys prefer ``CLARA_*`` and fall back to legacy ``NEMO_*`` for one release
(see :func:`env_clara`).
"""

from __future__ import annotations

import os


def env_clara(name: str, default: str = '') -> str:
    """Prefer ``CLARA_{name}``; fall back to legacy ``NEMO_{name}`` when unset/empty."""
    suffix = name[6:] if name.startswith('CLARA_') else name
    clara_key = f'CLARA_{suffix}'
    nemo_key = f'NEMO_{suffix}'
    return (os.getenv(clara_key) or os.getenv(nemo_key) or default).strip()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = env_clara(name, '').lower()
    if not raw:
        return default
    return raw in ('1', 'true', 'yes', 'on')


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = env_clara(name, '')
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(lo, min(value, hi))

# ---------------------------------------------------------------------------
# Agent architecture (single outer Clara agent with staging + specialist tools when Editor is on)
# ---------------------------------------------------------------------------
# Qwen / Gemma template defaults (see :mod:`clara_coder_backend.llm.model_tuning`): ``CLARA_QWEN_DEFAULT_MAX_OUTPUT_TOKENS``,
# ``CLARA_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS``, ``CLARA_CHAT_MAX_OUTPUT_TOKENS`` (applies to any model when set).
# Max characters returned from the worker to the manager (truncation with notice).
try:
    CLARA_WORKER_RESULT_MAX_CHARS = max(
        4_000,
        min(int(env_clara('CLARA_WORKER_RESULT_MAX_CHARS', '120000').strip() or '120000'), 500_000),
    )
except ValueError:
    CLARA_WORKER_RESULT_MAX_CHARS = 120_000

# ---------------------------------------------------------------------------
# Subprocess / verification (pytest, npm, etc.)
# ---------------------------------------------------------------------------
# Wall-clock cap for ``asyncio.subprocess.Process.communicate()`` in shared helpers; 0 disables the timeout.
try:
    CLARA_SUBPROCESS_TIMEOUT_SEC = max(
        0,
        min(int(env_clara('CLARA_SUBPROCESS_TIMEOUT_SEC', '900').strip() or '900'), 86_400),
    )
except ValueError:
    CLARA_SUBPROCESS_TIMEOUT_SEC = 900

# Default window ``run_command`` waits for a background command before returning its command id.
CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC = _env_int('CLARA_RUN_COMMAND_DEFAULT_WAIT_SEC', 30, 1, 3_600)
# Upper bound for any single ``run_command`` / ``wait_for_command`` wait window.
CLARA_RUN_COMMAND_MAX_WAIT_SEC = _env_int('CLARA_RUN_COMMAND_MAX_WAIT_SEC', 600, 30, 86_400)
# Fail-open cap for the side risk-assessment LLM call on `run_command` HITL approvals (see command_risk_assess.py).
CLARA_COMMAND_RISK_ASSESS_TIMEOUT_SEC = _env_int('CLARA_COMMAND_RISK_ASSESS_TIMEOUT_SEC', 15, 3, 120)

# Smoke tests against watch-mode dev servers (Vite, electronmon, ``ng serve``, etc.).
# After ``CLARA_SMOKE_STEADY_STATE_SEC`` without exit, a still-running process counts as passed steady state.
CLARA_SMOKE_STEADY_STATE_SEC = _env_int('CLARA_SMOKE_STEADY_STATE_SEC', 3, 1, 120)
# Extra output collection after readiness markers (``ready in``, ``Compiled successfully``, …).
CLARA_SMOKE_READINESS_SETTLE_SEC = _env_int('CLARA_SMOKE_READINESS_SETTLE_SEC', 1, 0, 30)

# ---------------------------------------------------------------------------
# Agent loop limits
# ---------------------------------------------------------------------------
# Each iteration is one LLM completion; a single step may execute several tools.
try:
    MAX_AGENT_STEPS = max(1, min(int(env_clara('CLARA_MAX_AGENT_STEPS', '400').strip() or '400'), 5000))
except ValueError:
    MAX_AGENT_STEPS = 400

# When the model returns no visible text, inject a nudge message instead of stopping.
MAX_AGENT_EMPTY_NUDGES = 2
# When the model writes <tool_call> / <function=...> in plain text (common with some Qwen stacks) but sends no
# API ``tool_calls``, re-prompt so the graph can reach the tool node. 0 = disable (same as max empty nudges).
try:
    MAX_AGENT_PSEUDO_TOOL_NUDGES = max(0, min(int(env_clara('CLARA_MAX_AGENT_PSEUDO_TOOL_NUDGES', '2') or '2'), 20))
except ValueError:
    MAX_AGENT_PSEUDO_TOOL_NUDGES = 2

# When staged drafts exist but the model tries to finish without calling transfer_staged_file_to_workspace.
try:
    MAX_AGENT_STAGING_CONTINUATION_NUDGES = max(
        0,
        min(int(env_clara('CLARA_MAX_AGENT_STAGING_CONTINUATION_NUDGES', '2') or '2'), 20),
    )
except ValueError:
    MAX_AGENT_STAGING_CONTINUATION_NUDGES = 2

# When the model's visible text ends by *announcing* an action ("I'll now check the file...", "Let me
# search for...") but the completion registers no API tool_calls, re-prompt instead of treating the
# announcement as the final answer. Seen with some Gemma stacks: the model commits to a next step in
# plain text and then ends the turn early instead of emitting the matching tool call. 0 = disable.
try:
    MAX_AGENT_ACTION_COMMITMENT_NUDGES = max(
        0,
        min(int(env_clara('CLARA_MAX_AGENT_ACTION_COMMITMENT_NUDGES', '2') or '2'), 20),
    )
except ValueError:
    MAX_AGENT_ACTION_COMMITMENT_NUDGES = 2

# ---------------------------------------------------------------------------
# Workspace tool limits
# ---------------------------------------------------------------------------
MAX_FILE_READ_LINES = 400
MAX_SEARCH_RESULTS = 40

# Workspace semantic index (LlamaIndex under ``.nemo/llama_index``).
# ``CLARA_EMBEDDINGS_MODEL`` = OpenAI-compatible embeddings model id (not the chat model).
# ``CLARA_EMBEDDINGS_BASE_URL`` / ``CLARA_EMBEDDINGS_API_KEY`` = optional separate embeddings endpoint (e.g. second ``llama-server``).
CLARA_LLAMA_INDEX_MAX_FILES = _env_int('CLARA_LLAMA_INDEX_MAX_FILES', 8000, 50, 100_000)
try:
    CLARA_LLAMA_INDEX_MAX_FILE_BYTES = max(
        4096,
        min(int(env_clara('CLARA_LLAMA_INDEX_MAX_FILE_BYTES', '512000').strip() or '512000'), 5_000_000),
    )
except ValueError:
    CLARA_LLAMA_INDEX_MAX_FILE_BYTES = 512_000
CLARA_EMBEDDINGS_MODEL = (env_clara('CLARA_EMBEDDINGS_MODEL', '') or 'text-embedding-3-small').strip()
# Optional: OpenAI-compatible embeddings endpoint separate from the active chat connection (e.g. second ``llama-server`` on another port).
CLARA_EMBEDDINGS_BASE_URL = (env_clara('CLARA_EMBEDDINGS_BASE_URL', '') or '').strip()
CLARA_EMBEDDINGS_API_KEY = (env_clara('CLARA_EMBEDDINGS_API_KEY', '') or '').strip()
# Split each embedding request into tiktoken-sized chunks (``cl100k_base``) at or below this size so local
# ``llama-server --embedding`` (default physical batch / ubatch 512) and mismatched model tokenizers do not 500.
CLARA_EMBEDDINGS_MAX_INPUT_TOKENS = _env_int('CLARA_EMBEDDINGS_MAX_INPUT_TOKENS', 384, 32, 8192)

# Seeds :attr:`~clara_coder_backend.session.state.runtime_config` before the first
# ``POST /runtime-config``; overridden by Settings → Tools.
CLARA_EDIT_TOOLS_STRICT = _env_bool('CLARA_EDIT_TOOLS_STRICT', False)

# Side-by-side diff payload (workspace edit tools)
MAX_DIFF_INPUT_BYTES = 1_500_000
MAX_DIFF_OUTPUT_ROWS = 12_000
# Full-file patch round-trip check can false-negative on large inputs; skip above this (UTF-8 byte length).
DIFF_VERIFY_PATCH_MAX_BYTES = 400_000

# Snippet merge: fuzzy locate (diff-match-patch match_main + SequenceMatcher check).
def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    raw = env_clara(name, '')
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        return default
    return max(lo, min(hi, v))


# Minimum similarity between matched window and old_snippet (higher = fewer false positives).
SNIPPET_FUZZY_MIN_SIMILARITY = _env_float('CLARA_SNIPPET_FUZZY_MIN_SIMILARITY', 0.88, 0.5, 1.0)
# If two distinct locations score within this margin of the best score and both >= min similarity, fuzzy match is rejected.
SNIPPET_FUZZY_TIE_DELTA = _env_float('CLARA_SNIPPET_FUZZY_TIE_DELTA', 0.02, 0.001, 0.15)
# diff-match-patch Match_Threshold for match_main (higher = stricter anchor).
SNIPPET_DMP_MATCH_THRESHOLD = _env_float('CLARA_SNIPPET_DMP_MATCH_THRESHOLD', 0.88, 0.5, 1.0)

# ---------------------------------------------------------------------------
# Streaming / UI status
# ---------------------------------------------------------------------------
TEXT_CHUNK_WORDS = 18
MAX_TOOL_STATUS_LINE = 200
# Max characters of read-tool output mirrored into the chat stream (per tool call).
try:
    MAX_READ_TOOL_STREAM_CHARS = max(
        8_000,
        min(int(env_clara('CLARA_MAX_READ_TOOL_STREAM_CHARS', '120000').strip() or '120000'), 500_000),
    )
except ValueError:
    MAX_READ_TOOL_STREAM_CHARS = 120_000

# ---------------------------------------------------------------------------
# LangGraph checkpoint context compression (Settings → Tools overrides via runtime-config)
# ---------------------------------------------------------------------------
CLARA_CONTEXT_COMPACT_ENABLED = _env_bool('CLARA_CONTEXT_COMPACT_ENABLED', True)
CLARA_CONTEXT_COMPACT_TRIGGER_RATIO = _env_float('CLARA_CONTEXT_COMPACT_TRIGGER_RATIO', 0.70, 0.5, 0.95)
CLARA_CONTEXT_COMPACT_TARGET_RATIO = _env_float('CLARA_CONTEXT_COMPACT_TARGET_RATIO', 0.55, 0.4, 0.90)
CLARA_CONTEXT_COMPACT_PROTECT_TAIL = _env_int('CLARA_CONTEXT_COMPACT_PROTECT_TAIL', 24, 8, 100)
CLARA_CONTEXT_COMPACT_RECENT_TOOL_CHARS = _env_int('CLARA_CONTEXT_COMPACT_RECENT_TOOL_CHARS', 2000, 200, 20_000)
CLARA_CONTEXT_COMPACT_OLD_TOOL_CHARS = _env_int('CLARA_CONTEXT_COMPACT_OLD_TOOL_CHARS', 400, 100, 10_000)
CLARA_CONTEXT_COMPACT_SYSTEM_RESERVE_RATIO = _env_float('CLARA_CONTEXT_COMPACT_SYSTEM_RESERVE_RATIO', 0.25, 0.1, 0.5)
CLARA_CONTEXT_WINDOW_FALLBACK = _env_int('CLARA_CONTEXT_WINDOW_FALLBACK', 128_000, 1024, 10_000_000)

# ---------------------------------------------------------------------------
# Default URLs and model names (overridable via env)
# ---------------------------------------------------------------------------
DEFAULT_LM_STUDIO_BASE_URL = os.getenv('LM_STUDIO_BASE_URL', 'http://127.0.0.1:1234/v1').strip()
DEFAULT_LLAMACPP_BASE_URL = os.getenv('LLAMACPP_BASE_URL', 'http://127.0.0.1:8080/v1').strip()
DEFAULT_OPENAI_BASE_URL = os.getenv('OPENAI_BASE_URL', '').strip()
DEFAULT_OPENAI_MODEL = os.getenv('OPENAI_MODEL', 'gpt-4o-mini')
DEFAULT_LM_STUDIO_MODEL = os.getenv('LM_STUDIO_MODEL', 'local-model')
DEFAULT_LLAMACPP_MODEL = os.getenv('LLAMACPP_MODEL', 'local-model')
DEFAULT_TRANSCRIBE_MODEL = env_clara('CLARA_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe')
