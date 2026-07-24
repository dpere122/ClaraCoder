"""LangChain agent tools for the outer Clara agent.

All model-facing tools live in this package. :mod:`nemo_backend.tool_registry`
assembles the bound tool list per session mode (read-only vs Editor, staging vs direct).

Modules
-------
``workspace`` — list/read/search workspace files, semantic retrieval, TOOLS assembly
``workspace_image`` — vision ``read_workspace_image``
``semantic`` — ``retrieve_workspace_semantic`` / checkpoint variant
``json_tools``, ``xml_tools``, ``wsdl_tools`` — structured format search-and-zoom readers
``copy``, ``delete``, ``edit``, ``staging_edit`` — workspace mutators (staging or direct)
``lsp_tools`` — LSP reads, diagnostics, and language-specific CRUD
``python_deps``, ``node_deps``, ``node_discovery``, ``npm_search``, ``angular_cli`` — dependencies
``python_env`` — workspace venv bootstrap
``process`` — ``search_netstat_ports``, ``kill_process``
``review_tools`` — staging inspect/format/transfer/reject/overlay
``project_review_tools`` — workspace pytest verification
``dependency_tools`` — named tool-list aggregators for registry merges
"""
