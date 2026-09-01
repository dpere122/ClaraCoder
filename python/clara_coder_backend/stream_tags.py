"""Shared leaf constants for multiplexed ``stream_tag`` values (Electron renderer + backend)."""

from __future__ import annotations

# Keep in sync with src/shared/stream-parts.ts (SSE auxiliary / reasoning).
REASONING_AUXILIARY_STREAM_TAG = 'reasoning'

# Premature primary prose promoted when EmptyResponseNudgeMiddleware jumps back to the model.
NUDGE_STREAM_TAG = 'nudge'

# Plan-and-execute planner status rows and progress payloads.
PLANNER_STREAM_TAG = 'planner'

# Tool multiplex lanes (keep in sync with stream-parts.ts).
READ_TOOL_PREVIEW_STREAM_TAG = 'tool-read-preview'
TOOL_OVERLAY_STREAM_TAG = 'tool-overlay'
TOOL_PYTEST_STREAM_TAG = 'tool-pytest'
TOOL_SMOKE_STREAM_TAG = 'tool-smoke'
TOOL_NODE_SMOKE_STREAM_TAG = 'tool-node-smoke'
