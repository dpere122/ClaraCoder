"""LangChain agent tools for the outer Clara agent.

All model-facing tools live in this package. :mod:`clara_coder_backend.hitl.tool_registry`
assembles the bound tool list per session mode (read-only vs Editor, staging vs direct).

Modules
-------
``workspace`` — list/read/search workspace files, semantic retrieval, TOOLS assembly
``workspace_image`` — vision ``read_workspace_image``
``semantic`` — ``retrieve_workspace_semantic`` / checkpoint variant
``json_tools``, ``xml_tools``, ``wsdl_tools`` — structured format search-and-zoom readers
``copy``, ``delete``, ``edit``, ``staging_edit`` — workspace mutators (staging or direct)
``lsp_tools`` — LSP reads, diagnostics, and language-specific CRUD
``run_command`` — managed background shell jobs (``wait_for_command`` / kill / list)
``write_jobs`` — managed staging write jobs (``wait_for_write`` / cancel / list)
``review_tools`` — staging inspect/format/transfer/reject/discard/overlay
``project_review_tools`` — shared subprocess streaming helpers for overlay
"""
