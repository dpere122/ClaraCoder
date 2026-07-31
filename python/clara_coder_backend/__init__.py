"""Clara Coder LangChain backend package.

FastAPI application and supporting modules for the Clara Coder Electron client.
Import :data:`clara_coder_backend.main.app` for ASGI servers (uvicorn).

The :mod:`clara_coder_backend.llm.langchain_compat` submodule applies one-time patches when
the package is first loaded.
"""

from __future__ import annotations

__version__ = '0.1.0'

# Side effect: reasoning_content compatibility for LangChain OpenAI chat models.
import clara_coder_backend.llm.langchain_compat  # noqa: F401
