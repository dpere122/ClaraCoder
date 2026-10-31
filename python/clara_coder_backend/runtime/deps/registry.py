"""Dependency registry: list / install / reinstall / delete."""

from __future__ import annotations

import logging
import traceback
from typing import Any

from clara_coder_backend.runtime.deps.cancel import InstallCancelled, installing, request_cancel
from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.registry')

DEPENDENCY_IDS = (
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
        whisper,
    )

    return {
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


def _components_for(provider: Any) -> list[str]:
    """Sub-dependencies a provider installs (shown as chips in the Dependencies window)."""

    fn = getattr(provider, 'components', None)
    if not callable(fn):
        return []
    try:
        return [str(c) for c in fn() if str(c).strip()]
    except Exception as exc:  # status must never fail because of a cosmetic list
        logger.debug('components() failed for %s: %s', getattr(provider, 'DEP_ID', provider), exc)
        return []


def get_dependency(dep_id: str) -> dict[str, Any]:
    provider = _providers().get(dep_id)
    if not provider:
        raise KeyError(f'Unknown dependency: {dep_id}')
    info = {**provider.status(), 'components': _components_for(provider)}
    if dep_id in _updating:
        info = {**info, 'state': 'updating'}
    elif dep_id in _errors and info.get('state') != 'installed':
        info = {**info, 'state': 'error', 'error': _errors[dep_id]}
    return info


def cleanup_after_cancel(dep_id: str) -> dict[str, Any]:
    """Remove what a cancelled install left behind.

    Provider scratch files (downloads, extract dirs) always go. If the dependency no longer
    reads as installed — a fresh install stopped midway, or a reinstall that had already
    removed the old copy — the half-written install is deleted too, so it shows as missing
    instead of broken. A still-valid install is left untouched.
    """

    provider = _providers().get(dep_id)
    if not provider:
        raise KeyError(f'Unknown dependency: {dep_id}')
    PROGRESS.emit(dep_id, 'cancelling', message='Cancelled. Removing partial files…')
    cleanup = getattr(provider, 'cleanup_partial', None)
    if callable(cleanup):
        try:
            cleanup()
        except Exception as exc:
            logger.warning('cleanup_partial %s failed: %s', dep_id, exc)
    try:
        still_installed = provider.status().get('state') == 'installed'
    except Exception:
        still_installed = False
    if still_installed:
        message = 'Install cancelled. The existing install was left as it was.'
    else:
        try:
            provider.delete()
            message = 'Install cancelled. Partial files were removed.'
        except Exception as exc:
            logger.warning('delete after cancel %s failed: %s', dep_id, exc)
            message = f'Install cancelled, but some partial files could not be removed: {exc}'
    logger.info('install %s cancelled; %s', dep_id, message)
    PROGRESS.emit(dep_id, 'cancelled', message=message)
    return get_dependency(dep_id)


def install_dependency(dep_id: str, *, force: bool = False, variant: str | None = None) -> dict[str, Any]:
    provider = _providers().get(dep_id)
    if not provider:
        raise KeyError(f'Unknown dependency: {dep_id}')
    _updating.add(dep_id)
    _errors.pop(dep_id, None)
    PROGRESS.emit(dep_id, 'queued', message='Starting…')
    try:
        install_fn = provider.install
        with installing(dep_id):
            try:
                result = install_fn(force=force, variant=variant)
            except TypeError:
                # Provider does not accept a variant kwarg (only llama-server does).
                result = install_fn(force=force)
        _errors.pop(dep_id, None)
        return result
    except InstallCancelled:
        _updating.discard(dep_id)
        cleanup_after_cancel(dep_id)
        raise
    except Exception as exc:
        msg = str(exc) or exc.__class__.__name__
        logger.error('install %s failed: %s\n%s', dep_id, msg, traceback.format_exc())
        _errors[dep_id] = msg
        PROGRESS.emit(dep_id, 'error', message=msg)
        raise
    finally:
        _updating.discard(dep_id)


def cancel_install(dep_id: str) -> bool:
    """Ask a running install to stop. Returns False when nothing is installing ``dep_id``."""

    if dep_id not in DEPENDENCY_IDS:
        raise KeyError(f'Unknown dependency: {dep_id}')
    if dep_id not in _updating:
        return False
    request_cancel(dep_id)
    return True


def reinstall_dependency(dep_id: str, variant: str | None = None) -> dict[str, Any]:
    return install_dependency(dep_id, force=True, variant=variant)


def delete_dependency(dep_id: str) -> dict[str, Any]:
    provider = _providers().get(dep_id)
    if not provider:
        raise KeyError(f'Unknown dependency: {dep_id}')
    _errors.pop(dep_id, None)
    return provider.delete()
