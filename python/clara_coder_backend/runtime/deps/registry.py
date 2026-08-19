"""Dependency registry: list / install / reinstall / delete."""

from __future__ import annotations

import logging
import traceback
from typing import Any

from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.registry')

DEPENDENCY_IDS = (
    'python-runtime',
    'llama-server',
    'java-lsp',
    'kokoro',
    'whisper',
)


def _providers():
    from clara_coder_backend.runtime.deps.providers import (
        java_lsp,
        kokoro,
        llama_server,
        python_runtime,
        whisper,
    )

    return {
        'python-runtime': python_runtime,
        'llama-server': llama_server,
        'java-lsp': java_lsp,
        'kokoro': kokoro,
        'whisper': whisper,
    }

# Track in-flight installs for status overlay
_updating: set[str] = set()
_errors: dict[str, str] = {}


def list_dependencies() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for dep_id in DEPENDENCY_IDS:
        try:
            info = get_dependency(dep_id)
        except Exception as exc:
            logger.warning('status failed for %s: %s', dep_id, exc)
            info = {
                'id': dep_id,
                'label': dep_id,
                'description': '',
                'version': None,
                'state': 'error',
                'path': None,
                'sizeHint': '',
                'canDelete': True,
                'error': str(exc),
            }
        out.append(info)
    return out


def get_dependency(dep_id: str) -> dict[str, Any]:
    provider = _providers().get(dep_id)
    if not provider:
        raise KeyError(f'Unknown dependency: {dep_id}')
    info = provider.status()
    if dep_id in _updating:
        info = {**info, 'state': 'updating'}
    elif dep_id in _errors and info.get('state') != 'installed':
        info = {**info, 'state': 'error', 'error': _errors[dep_id]}
    return info


def install_dependency(dep_id: str, *, force: bool = False, variant: str | None = None) -> dict[str, Any]:
    provider = _providers().get(dep_id)
    if not provider:
        raise KeyError(f'Unknown dependency: {dep_id}')
    _updating.add(dep_id)
    _errors.pop(dep_id, None)
    PROGRESS.emit(dep_id, 'queued', message='Starting…')
    try:
        install_fn = provider.install
        try:
            result = install_fn(force=force, variant=variant)
        except TypeError:
            # Provider does not accept a variant kwarg (only llama-server does).
            result = install_fn(force=force)
        _errors.pop(dep_id, None)
        return result
    except Exception as exc:
        msg = str(exc) or exc.__class__.__name__
        logger.error('install %s failed: %s\n%s', dep_id, msg, traceback.format_exc())
        _errors[dep_id] = msg
        PROGRESS.emit(dep_id, 'error', message=msg)
        raise
    finally:
        _updating.discard(dep_id)


def reinstall_dependency(dep_id: str, variant: str | None = None) -> dict[str, Any]:
    return install_dependency(dep_id, force=True, variant=variant)


def delete_dependency(dep_id: str) -> dict[str, Any]:
    provider = _providers().get(dep_id)
    if not provider:
        raise KeyError(f'Unknown dependency: {dep_id}')
    _errors.pop(dep_id, None)
    return provider.delete()
