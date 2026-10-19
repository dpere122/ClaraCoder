"""HTTP API for managed runtime dependencies."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from clara_coder_backend.runtime.deps.cancel import InstallCancelled
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.runtime.deps.registry import (
    DEPENDENCY_IDS,
    cancel_install,
    delete_dependency,
    get_dependency,
    install_dependency,
    list_dependencies,
    reinstall_dependency,
)

router = APIRouter(prefix='/runtime/deps', tags=['deps'])


class DepActionBody(BaseModel):
    depId: str = Field(..., description='Dependency id')
    variant: str | None = Field(None, description='Optional llama-server build variant override')


def _validate_id(dep_id: str) -> str:
    if dep_id not in DEPENDENCY_IDS:
        raise HTTPException(status_code=400, detail=f'Unknown dependency: {dep_id}')
    return dep_id


@router.get('/list')
async def deps_list() -> dict[str, Any]:
    return {'ok': True, 'dependencies': list_dependencies()}


@router.get('/status/{dep_id}')
async def deps_status(dep_id: str) -> dict[str, Any]:
    _validate_id(dep_id)
    return {'ok': True, 'dependency': get_dependency(dep_id)}


@router.post('/install')
async def deps_install(body: DepActionBody) -> dict[str, Any]:
    dep_id = _validate_id(body.depId)
    try:
        dep = await asyncio.to_thread(install_dependency, dep_id, force=False, variant=body.variant)
        return {'ok': True, 'dependency': dep}
    except InstallCancelled:
        return {'ok': False, 'cancelled': True, 'error': 'Install cancelled', 'dependency': get_dependency(dep_id)}
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'dependency': get_dependency(dep_id)}


@router.post('/reinstall')
async def deps_reinstall(body: DepActionBody) -> dict[str, Any]:
    dep_id = _validate_id(body.depId)
    try:
        dep = await asyncio.to_thread(reinstall_dependency, dep_id, variant=body.variant)
        return {'ok': True, 'dependency': dep}
    except InstallCancelled:
        return {'ok': False, 'cancelled': True, 'error': 'Install cancelled', 'dependency': get_dependency(dep_id)}
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'dependency': get_dependency(dep_id)}


@router.post('/cancel')
async def deps_cancel(body: DepActionBody) -> dict[str, Any]:
    """Ask a running install/reinstall to stop; it cleans up partial files before returning."""

    dep_id = _validate_id(body.depId)
    if not cancel_install(dep_id):
        return {'ok': False, 'error': f'No {dep_id} install is running'}
    return {'ok': True}


@router.post('/delete')
async def deps_delete(body: DepActionBody) -> dict[str, Any]:
    dep_id = _validate_id(body.depId)
    try:
        dep = await asyncio.to_thread(delete_dependency, dep_id)
        return {'ok': True, 'dependency': dep}
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'dependency': get_dependency(dep_id)}


@router.get('/progress')
async def deps_progress_stream() -> StreamingResponse:
    """SSE stream of progress events for the Dependencies window."""

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    def _on_progress(payload: dict[str, Any]) -> None:
        # Providers emit from worker threads (asyncio.to_thread); bridge into the loop.
        try:
            loop.call_soon_threadsafe(queue.put_nowait, payload)
        except Exception:
            pass

    PROGRESS.subscribe(_on_progress)

    async def event_gen():
        try:
            yield f'data: {json.dumps({"phase": "subscribed"})}\n\n'
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
                    continue
                if item is None:
                    break
                yield f'data: {json.dumps(item)}\n\n'
        finally:
            PROGRESS.unsubscribe(_on_progress)

    return StreamingResponse(event_gen(), media_type='text/event-stream')
