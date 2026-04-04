"""Central configuration for the Nemo backend.

Reads environment variables once at import time and defines numeric limits used by
the agent loop, workspace tools, and streaming chunking. Other modules import
constants from here to avoid circular imports with runtime state.
"""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Agent loop limits
# ---------------------------------------------------------------------------
# Each iteration is one LLM completion; a single step may execute several tools.
try:
    MAX_AGENT_STEPS = max(1, min(int(os.getenv('NEMO_MAX_AGENT_STEPS', '400').strip() or '400'), 5000))
except ValueError:
    MAX_AGENT_STEPS = 400

# When finish_reason is "length", ask the model to continue (do not treat as final).
MAX_AGENT_LENGTH_CONTINUES = 3
# When the model returns no visible text, inject a nudge message instead of stopping.
MAX_AGENT_EMPTY_NUDGES = 2
# Some models write <tool_call> in plain text; nudge them to use API tool_calls.
MAX_AGENT_TOOL_FORMAT_NUDGES = 3

# ---------------------------------------------------------------------------
# Workspace tool limits
# ---------------------------------------------------------------------------
MAX_FILE_READ_LINES = 400
MAX_SEARCH_RESULTS = 40

# ---------------------------------------------------------------------------
# Streaming / UI status
# ---------------------------------------------------------------------------
TEXT_CHUNK_WORDS = 18
MAX_TOOL_STATUS_LINE = 200

# ---------------------------------------------------------------------------
# Default URLs and model names (overridable via env)
# ---------------------------------------------------------------------------
DEFAULT_LM_STUDIO_BASE_URL = os.getenv('LM_STUDIO_BASE_URL', 'http://127.0.0.1:1234/v1').strip()
DEFAULT_OPENAI_BASE_URL = os.getenv('OPENAI_BASE_URL', '').strip()
DEFAULT_OPENAI_MODEL = os.getenv('OPENAI_MODEL', 'gpt-4o-mini')
DEFAULT_LM_STUDIO_MODEL = os.getenv('LM_STUDIO_MODEL', 'local-model')
DEFAULT_TRANSCRIBE_MODEL = os.getenv('NEMO_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe')
