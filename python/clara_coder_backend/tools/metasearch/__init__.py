"""Built-in metasearch backend: a small, dependency-free stand-in for SearXNG.

``metasearch`` fans a query out to several public engines, normalizes and dedupes the
hits, and ranks the merged list. ``web_search`` uses it when no SearXNG instance is
configured (or when Settings → Tools selects the built-in provider).

Engines that answer with a rate limit or a captcha are parked by
:mod:`clara_coder_backend.tools.metasearch.cooldown` and cycled past on the next query.
"""

from clara_coder_backend.tools.metasearch.aggregate import MetasearchOutcome, metasearch, normalize_url
from clara_coder_backend.tools.metasearch.cache import clear_cache
from clara_coder_backend.tools.metasearch.cooldown import clear_cooldowns, cooldown_remaining, snapshot
from clara_coder_backend.tools.metasearch.engines import DEFAULT_USER_AGENT, ENGINE_NAMES, EngineBlocked

__all__ = [
    'DEFAULT_USER_AGENT',
    'ENGINE_NAMES',
    'EngineBlocked',
    'MetasearchOutcome',
    'clear_cache',
    'clear_cooldowns',
    'cooldown_remaining',
    'metasearch',
    'normalize_url',
    'snapshot',
]
