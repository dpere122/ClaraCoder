"""Central configuration for the Nemo backend.

Reads environment variables once at import time and defines numeric limits used by
the agent loop, workspace tools, and streaming chunking. Other modules import
constants from here to avoid circular imports with runtime state.
"""

from __future__ import annotations

import os


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, '').strip().lower()
    if not raw:
        return default
    return raw in ('1', 'true', 'yes', 'on')


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.getenv(name, '').strip()
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
# Qwen / Gemma template defaults (see :mod:`nemo_backend.model_tuning`): ``NEMO_QWEN_DEFAULT_MAX_OUTPUT_TOKENS``,
# ``NEMO_GEMMA_DEFAULT_MAX_OUTPUT_TOKENS``, ``NEMO_CHAT_MAX_OUTPUT_TOKENS`` (applies to any model when set).
# Max characters returned from the worker to the manager (truncation with notice).
try:
    NEMO_WORKER_RESULT_MAX_CHARS = max(
        4_000,
        min(int(os.getenv('NEMO_WORKER_RESULT_MAX_CHARS', '120000').strip() or '120000'), 500_000),
    )
except ValueError:
    NEMO_WORKER_RESULT_MAX_CHARS = 120_000

# ---------------------------------------------------------------------------
# Subprocess / verification (pytest, npm, etc.)
# ---------------------------------------------------------------------------
# Wall-clock cap for ``asyncio.subprocess.Process.communicate()`` in shared helpers; 0 disables the timeout.
try:
    NEMO_SUBPROCESS_TIMEOUT_SEC = max(
        0,
        min(int(os.getenv('NEMO_SUBPROCESS_TIMEOUT_SEC', '900').strip() or '900'), 86_400),
    )
except ValueError:
    NEMO_SUBPROCESS_TIMEOUT_SEC = 900

# Separate cap for ``npm run`` / ``pnpm run`` / ``yarn run`` (often starts a server). 0 = use
# ``NEMO_SUBPROCESS_TIMEOUT_SEC`` instead. Prevents hung or long-lived script processes.
NEMO_NPM_SCRIPT_TIMEOUT_SEC = _env_int('NEMO_NPM_SCRIPT_TIMEOUT_SEC', 300, 0, 86_400)

# Smoke tests against watch-mode dev servers (Vite, electronmon, ``ng serve``, etc.).
# After ``NEMO_SMOKE_STEADY_STATE_SEC`` without exit, a still-running process counts as passed steady state.
NEMO_SMOKE_STEADY_STATE_SEC = _env_int('NEMO_SMOKE_STEADY_STATE_SEC', 3, 1, 120)
# Extra output collection after readiness markers (``ready in``, ``Compiled successfully``, …).
NEMO_SMOKE_READINESS_SETTLE_SEC = _env_int('NEMO_SMOKE_READINESS_SETTLE_SEC', 1, 0, 30)

# ---------------------------------------------------------------------------
# Agent loop limits
# ---------------------------------------------------------------------------
# Each iteration is one LLM completion; a single step may execute several tools.
try:
    MAX_AGENT_STEPS = max(1, min(int(os.getenv('NEMO_MAX_AGENT_STEPS', '400').strip() or '400'), 5000))
except ValueError:
    MAX_AGENT_STEPS = 400

# When the model returns no visible text, inject a nudge message instead of stopping.
MAX_AGENT_EMPTY_NUDGES = 2
# When the model writes <tool_call> / <function=...> in plain text (common with some Qwen stacks) but sends no
# API ``tool_calls``, re-prompt so the graph can reach the tool node. 0 = disable (same as max empty nudges).
try:
    MAX_AGENT_PSEUDO_TOOL_NUDGES = max(0, min(int(os.getenv('NEMO_MAX_AGENT_PSEUDO_TOOL_NUDGES', '2') or '2'), 20))
except ValueError:
    MAX_AGENT_PSEUDO_TOOL_NUDGES = 2

# ---------------------------------------------------------------------------
# Workspace tool limits
# ---------------------------------------------------------------------------
MAX_FILE_READ_LINES = 400
MAX_SEARCH_RESULTS = 40

# Workspace semantic index (LlamaIndex under ``.nemo/llama_index``).
# ``NEMO_EMBEDDINGS_MODEL`` = OpenAI-compatible embeddings model id (not the chat model).
# ``NEMO_EMBEDDINGS_BASE_URL`` / ``NEMO_EMBEDDINGS_API_KEY`` = optional separate embeddings endpoint (e.g. second ``llama-server``).
NEMO_LLAMA_INDEX_MAX_FILES = _env_int('NEMO_LLAMA_INDEX_MAX_FILES', 8000, 50, 100_000)
try:
    NEMO_LLAMA_INDEX_MAX_FILE_BYTES = max(
        4096,
        min(int(os.getenv('NEMO_LLAMA_INDEX_MAX_FILE_BYTES', '512000').strip() or '512000'), 5_000_000),
    )
except ValueError:
    NEMO_LLAMA_INDEX_MAX_FILE_BYTES = 512_000
NEMO_EMBEDDINGS_MODEL = (os.getenv('NEMO_EMBEDDINGS_MODEL', '') or 'text-embedding-3-small').strip()
# Optional: OpenAI-compatible embeddings endpoint separate from the active chat connection (e.g. second ``llama-server`` on another port).
NEMO_EMBEDDINGS_BASE_URL = (os.getenv('NEMO_EMBEDDINGS_BASE_URL', '') or '').strip()
NEMO_EMBEDDINGS_API_KEY = (os.getenv('NEMO_EMBEDDINGS_API_KEY', '') or '').strip()
# Split each embedding request into tiktoken-sized chunks (``cl100k_base``) at or below this size so local
# ``llama-server --embedding`` (default physical batch / ubatch 512) and mismatched model tokenizers do not 500.
NEMO_EMBEDDINGS_MAX_INPUT_TOKENS = _env_int('NEMO_EMBEDDINGS_MAX_INPUT_TOKENS', 384, 32, 8192)

# Seeds :attr:`~nemo_backend.state.runtime_config` before the first ``POST /runtime-config``; overridden by Settings → Tools.
NEMO_EDIT_TOOLS_STRICT = _env_bool('NEMO_EDIT_TOOLS_STRICT', False)

# Side-by-side diff payload (workspace edit tools)
MAX_DIFF_INPUT_BYTES = 1_500_000
MAX_DIFF_OUTPUT_ROWS = 12_000
# Full-file patch round-trip check can false-negative on large inputs; skip above this (UTF-8 byte length).
DIFF_VERIFY_PATCH_MAX_BYTES = 400_000

# Snippet merge: fuzzy locate (diff-match-patch match_main + SequenceMatcher check).
def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    raw = os.getenv(name, '').strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        return default
    return max(lo, min(hi, v))


# Minimum similarity between matched window and old_snippet (higher = fewer false positives).
SNIPPET_FUZZY_MIN_SIMILARITY = _env_float('NEMO_SNIPPET_FUZZY_MIN_SIMILARITY', 0.88, 0.5, 1.0)
# If two distinct locations score within this margin of the best score and both >= min similarity, fuzzy match is rejected.
SNIPPET_FUZZY_TIE_DELTA = _env_float('NEMO_SNIPPET_FUZZY_TIE_DELTA', 0.02, 0.001, 0.15)
# diff-match-patch Match_Threshold for match_main (higher = stricter anchor).
SNIPPET_DMP_MATCH_THRESHOLD = _env_float('NEMO_SNIPPET_DMP_MATCH_THRESHOLD', 0.88, 0.5, 1.0)

# ---------------------------------------------------------------------------
# Streaming / UI status
# ---------------------------------------------------------------------------
TEXT_CHUNK_WORDS = 18
MAX_TOOL_STATUS_LINE = 200
# Max characters of read-tool output mirrored into the chat stream (per tool call).
try:
    MAX_READ_TOOL_STREAM_CHARS = max(
        8_000,
        min(int(os.getenv('NEMO_MAX_READ_TOOL_STREAM_CHARS', '120000').strip() or '120000'), 500_000),
    )
except ValueError:
    MAX_READ_TOOL_STREAM_CHARS = 120_000

# ---------------------------------------------------------------------------
# Default URLs and model names (overridable via env)
# ---------------------------------------------------------------------------
DEFAULT_LM_STUDIO_BASE_URL = os.getenv('LM_STUDIO_BASE_URL', 'http://127.0.0.1:1234/v1').strip()
DEFAULT_LLAMACPP_BASE_URL = os.getenv('LLAMACPP_BASE_URL', 'http://127.0.0.1:8080/v1').strip()
DEFAULT_OPENAI_BASE_URL = os.getenv('OPENAI_BASE_URL', '').strip()
DEFAULT_OPENAI_MODEL = os.getenv('OPENAI_MODEL', 'gpt-4o-mini')
DEFAULT_LM_STUDIO_MODEL = os.getenv('LM_STUDIO_MODEL', 'local-model')
DEFAULT_LLAMACPP_MODEL = os.getenv('LLAMACPP_MODEL', 'local-model')
DEFAULT_TRANSCRIBE_MODEL = os.getenv('NEMO_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe')
PLAN_RETRY_ATTEMPTS_COUNT = _env_int('PLAN_RETRY_ATTEMPTS_COUNT', 2, 0, 20)
