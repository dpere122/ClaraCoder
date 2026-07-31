"""Dependency tool lists merged into the outer Clara agent."""

from __future__ import annotations

from typing import Any

from clara_coder_backend.tools.angular_cli import angular_cli_tool
from clara_coder_backend.tools.node_deps import (
    install_npm_packages_tool,
    npm_install_project_tool,
    remove_npm_packages_tool,
    run_npm_script_tool,
)
from clara_coder_backend.tools.node_discovery import discover_npm_projects_tool
from clara_coder_backend.tools.npm_search import search_npm_packages_tool
from clara_coder_backend.tools.python_deps import (
    freeze_python_requirements_tool,
    install_python_packages_tool,
    install_python_requirements_file_tool,
    remove_python_packages_tool,
    write_frozen_python_requirements_file_tool,
)


def dependency_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    t = [
        install_python_packages_tool,
        remove_python_packages_tool,
        install_python_requirements_file_tool,
        freeze_python_requirements_tool,
        write_frozen_python_requirements_file_tool,
    ]
    return t, {tool_.name: tool_ for tool_ in t}


def node_dependency_specialist_tools() -> tuple[list[Any], dict[str, Any]]:
    """Node/npm/pnpm/Yarn plus local ``angular_cli_tool``."""

    t = [
        discover_npm_projects_tool,
        search_npm_packages_tool,
        install_npm_packages_tool,
        remove_npm_packages_tool,
        npm_install_project_tool,
        run_npm_script_tool,
        angular_cli_tool,
    ]
    return t, {tool_.name: tool_ for tool_ in t}
