"""Built-in context packs; import side effects register each pack."""

from __future__ import annotations

from clara_coder_backend.context_packs.packs import json as _json
from clara_coder_backend.context_packs.packs import pdf as _pdf
from clara_coder_backend.context_packs.packs import theme as _theme
from clara_coder_backend.context_packs.packs import wsdl as _wsdl
from clara_coder_backend.context_packs.packs import xml as _xml

__all__ = ['_json', '_pdf', '_theme', '_wsdl', '_xml']
