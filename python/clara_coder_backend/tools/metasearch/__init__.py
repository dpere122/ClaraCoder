"""Built-in metasearch backend: a small, dependency-free stand-in for SearXNG.

``metasearch`` fans a query out to several public engines, normalizes and dedupes the
hits, and ranks the merged list. ``web_search`` uses it when no SearXNG instance is
configured (or when Settings → Tools selects the built-in provider).
"""

from clara_coder_backend.tools.metasearch.aggregate import MetasearchOutcome, metasearch, normalize_url
from clara_coder_backend.tools.metasearch.cache import clear_cache
from clara_coder_backend.tools.metasearch.engines import ENGINE_NAMES

__all__ = [
    'ENGINE_NAMES',
    'MetasearchOutcome',
    'clear_cache',
    'metasearch',
    'normalize_url',
]
