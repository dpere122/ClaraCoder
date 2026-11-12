"""End-of-turn verification: evidence the harness gathers itself before an editing turn may finish.

- :mod:`.checks_config` reads the user's check commands from ``.clara/checks.json``.
- :mod:`.evidence` collects LSP errors on the files the turn touched and runs the checks.
- :mod:`clara_coder_backend.middleware.turn_verification_middleware` hands failures back to the model.
"""

from __future__ import annotations
