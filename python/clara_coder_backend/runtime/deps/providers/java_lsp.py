"""Manage Eclipse JDT Language Server via the shared ensure API."""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from clara_coder_backend.runtime.deps.paths import get_runtime_dir, get_runtime_java_lsp_dir
from clara_coder_backend.runtime.deps.progress import PROGRESS

logger = logging.getLogger('clara.runtime.deps.java_lsp')

DEP_ID = 'java-lsp'
SIZE_HINT = '~50–80 MB'


def _ensure_cache_env() -> Path:
    """Pin ``CLARA_JAVA_LSP_CACHE_DIR`` to the canonical runtime path before ensure/status."""

    cache = get_runtime_java_lsp_dir()
    os.environ['CLARA_JAVA_LSP_CACHE_DIR'] = str(cache)
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def _java_server():
    # Submodule import (avoid heavy ``lsp.manager`` via package ``__init__`` side effects).
    from clara_coder_backend.lsp import java_server as mod

    return mod


def _legacy_java_lsp_dir() -> Path | None:
    """Sibling of ``runtime/`` when Electron app-data layout is ``…/clara-coder/runtime``."""

    runtime = get_runtime_dir()
    # …/clara-coder/runtime → …/clara-coder/java-lsp
    candidate = runtime.parent / 'java-lsp'
    if candidate.is_dir() and candidate.resolve() != get_runtime_java_lsp_dir().resolve():
        return candidate
    return None


def _product_dir() -> Path | None:
    _ensure_cache_env()
    return _java_server().get_jdtls_product_dir_if_ready()


def status() -> dict:
    product = _product_dir()
    if product:
        version = (product / '.nemo-ready').read_text(encoding='utf-8').strip() or product.name
        return {
            'id': DEP_ID,
            'label': 'Java LSP (JDT LS)',
            'description': 'Eclipse JDT Language Server for Java diagnostics and navigation.',
            'version': version,
            'state': 'installed',
            'path': str(product),
            'sizeHint': SIZE_HINT,
            'canDelete': True,
            'error': None,
        }
    return {
        'id': DEP_ID,
        'label': 'Java LSP (JDT LS)',
        'description': 'Eclipse JDT Language Server for Java diagnostics and navigation.',
        'version': None,
        'state': 'missing',
        'path': None,
        'sizeHint': SIZE_HINT,
        'canDelete': True,
        'error': None,
    }


def install(*, force: bool = False) -> dict:
    java_server = _java_server()
    PROGRESS.emit(DEP_ID, 'downloading', message='Downloading Eclipse JDT LS…')
    _ensure_cache_env()
    try:
        product = java_server.ensure_jdtls_product_dir(force_download=force)
    except java_server.JavaLspSetupError as exc:
        PROGRESS.emit(DEP_ID, 'error', message=str(exc))
        raise
    PROGRESS.emit(DEP_ID, 'done', message=f'Java LSP ready at {product}')
    return status()


def delete() -> dict:
    cache = _ensure_cache_env()
    jdtls = cache / 'jdtls'
    if jdtls.exists():
        shutil.rmtree(jdtls, ignore_errors=True)
    downloads = cache / 'downloads'
    if downloads.exists():
        shutil.rmtree(downloads, ignore_errors=True)
    legacy = _legacy_java_lsp_dir()
    if legacy is not None and legacy.exists():
        shutil.rmtree(legacy, ignore_errors=True)
    PROGRESS.emit(DEP_ID, 'done', message='Java LSP removed')
    return status()
