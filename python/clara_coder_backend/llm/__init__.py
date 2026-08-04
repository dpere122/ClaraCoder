"""LLM factory, prompts, and model-specific plumbing.

Modules
-------
``factory`` — ``ChatOpenAI`` / connection factory (``build_llm``)
``model_tuning`` — Qwen-style presets, max tokens, parallel tool heuristics
``messages`` — history → LangChain messages, system prompt, text helpers
``langchain_compat`` — patches for ``reasoning_content`` on some gateways
``gemma_output`` — Gemma-specific output handling
``prompt_blocks`` — reusable system-prompt blocks

Checkpoint compaction lives in :mod:`clara_coder_backend.lang_agent.context_compression`.
"""

from clara_coder_backend.llm.factory import build_llm

__all__ = ["build_llm"]
