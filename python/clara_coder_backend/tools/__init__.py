"""LangChain agent tools for the outer Clara agent.

All model-facing tools live in this package. :mod:`clara_coder_backend.hitl.tool_registry`
assembles the bound tool list per session mode (read-only vs Editor).

Modules
-------
``workspace`` — list/read/search workspace files, semantic retrieval, TOOLS assembly
``workspace_image`` — vision ``read_workspace_image``
``semantic`` — ``retrieve_workspace_semantic`` / checkpoint variant
``structured_tools`` — WSDL / XML / JSON search-and-zoom (format backends: ``json_tools``, ``xml_tools``, ``wsdl_tools``)
``copy``, ``delete``, ``edit`` — workspace mutators (write to disk; journaled per turn for review/reset)
``lsp_tools`` — LSP reads and diagnostics
``run_command`` — managed background shell jobs (``wait_for_command`` / kill / list)
``project_review_tools`` — shared subprocess streaming helpers (``RollingTextBuffer``)
"""
