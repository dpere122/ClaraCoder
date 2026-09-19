"""Process/runtime helpers: Python env, interpreters, subprocess, URLs.

Modules
-------
``python_env`` — workspace venv create/attach and interpreter PATH helpers
``python_bootstrap`` — install workspace requirements into the session venv
``python_interpreter_select`` — choose interpreter for tools/LSP
``subprocess_smoke`` — short subprocess smoke checks
``http_url_normalize`` — normalize OpenAI-compatible base URLs
``admin_exec`` / ``admin_broker`` — elevated ``run_command`` helper (Windows UAC / Linux pkexec)
``deps`` — managed app dependencies (Python runtime, llama-server, JDT LS, Kokoro)
"""
