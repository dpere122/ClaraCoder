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
# Agent architecture (single outer agent + nested router/specialists via plan_and_modify / execute_workspace_mutation)
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
# Coding planner agent (sits between outer Clara and the router/specialists)
# ---------------------------------------------------------------------------
# Set to false/0 to bypass the planner and delegate directly to the router (pre-planner behaviour).
NEMO_CODING_PLANNER_ENABLED = _env_bool('NEMO_CODING_PLANNER_ENABLED', True)
# Max characters of each step result returned to the planner from the router.
try:
    NEMO_PLANNER_STEP_RESULT_MAX_CHARS = max(
        4_000,
        min(int(os.getenv('NEMO_PLANNER_STEP_RESULT_MAX_CHARS', '80000').strip() or '80000'), 500_000),
    )
except ValueError:
    NEMO_PLANNER_STEP_RESULT_MAX_CHARS = 80_000
# Max characters per outer-agent brief (planner plan summary, review outcomes to Clara).
try:
    NEMO_OUTER_AGENT_BRIEF_MAX_CHARS = max(
        400,
        min(int(os.getenv('NEMO_OUTER_AGENT_BRIEF_MAX_CHARS', '2400').strip() or '2400'), 50_000),
    )
except ValueError:
    NEMO_OUTER_AGENT_BRIEF_MAX_CHARS = 2400
# Step sizing / complexity heuristics for discovery-first planning.
NEMO_PLANNER_REQUEST_SMALL_CHARS = _env_int('NEMO_PLANNER_REQUEST_SMALL_CHARS', 220, 80, 10_000)
NEMO_PLANNER_REQUEST_MEDIUM_CHARS = _env_int('NEMO_PLANNER_REQUEST_MEDIUM_CHARS', 500, 120, 20_000)
NEMO_PLANNER_REQUEST_LARGE_CHARS = _env_int('NEMO_PLANNER_REQUEST_LARGE_CHARS', 900, 200, 50_000)
NEMO_PLANNER_COMPLEXITY_BREADTH_WEIGHT = _env_int('NEMO_PLANNER_COMPLEXITY_BREADTH_WEIGHT', 1, 0, 10)
NEMO_PLANNER_COMPLEXITY_CONSTRAINT_WEIGHT = _env_int('NEMO_PLANNER_COMPLEXITY_CONSTRAINT_WEIGHT', 1, 0, 10)
NEMO_PLANNER_COMPLEXITY_KEYWORD_WEIGHT = _env_int('NEMO_PLANNER_COMPLEXITY_KEYWORD_WEIGHT', 1, 0, 10)
NEMO_PLANNER_COMPLEXITY_MAX_SCORE = _env_int('NEMO_PLANNER_COMPLEXITY_MAX_SCORE', 10, 2, 20)
NEMO_PLANNER_MAX_STEP_TEXT_CHARS = _env_int('NEMO_PLANNER_MAX_STEP_TEXT_CHARS', 160, 40, 500)
NEMO_PLANNER_FORCE_DISCOVERY_SCORE = _env_int('NEMO_PLANNER_FORCE_DISCOVERY_SCORE', 4, 1, 20)
# When True, structured build-plan generation must follow discovery-tool usage when the task mentions a programming path.
NEMO_PLANNER_REQUIRE_DISCOVERY_FOR_CODE_PATHS = _env_bool('NEMO_PLANNER_REQUIRE_DISCOVERY_FOR_CODE_PATHS', True)
NEMO_PLANNER_REFLECTION_RETRIES = _env_int('NEMO_PLANNER_REFLECTION_RETRIES', 2, 0, 10)
# When True, a short LLM plan probe may route `plan_and_modify` to a fast path (sequential nested steps + final review)
# when the probed checklist has 1..NEMO_PLAN_FAST_PATH_MAX_STEPS steps. Disable to always use the full coding planner graph.
NEMO_PLAN_PROBE_ENABLED = _env_bool('NEMO_PLAN_PROBE_ENABLED', True)
# Fast path runs only when the probed plan has at most this many steps (default 3 = fewer than 4 steps).
NEMO_PLAN_FAST_PATH_MAX_STEPS = _env_int('NEMO_PLAN_FAST_PATH_MAX_STEPS', 3, 1, 6)
# If `_task_complexity_profile(...).max_steps` is at or above this threshold, skip the probe and use the full planner.
NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS = _env_int(
    'NEMO_PLAN_SKIP_PROBE_MIN_COMPLEXITY_MAX_STEPS', 4, 1, 20
)
# Recursion limit for the bounded discovery mini-agent (read/search/LSP only) before build-plan generation.
NEMO_PLANNER_DISCOVERY_RECURSION_LIMIT = _env_int('NEMO_PLANNER_DISCOVERY_RECURSION_LIMIT', 24, 4, 80)

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
