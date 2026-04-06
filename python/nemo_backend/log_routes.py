"""HTTP endpoints for live log tail and Electron ingest."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from nemo_backend.app_logging import (
    get_recent_records,
    get_records_since,
    log_ingest,
    set_nemo_log_level,
)
from nemo_backend.schemas import LogIngestRequest, LogLevelRequest

router = APIRouter(prefix='/logs', tags=['logs'])


@router.get('/recent')
async def logs_recent(limit: int = Query(200, ge=1, le=2000)) -> dict:
    return {'records': get_recent_records(limit)}


@router.get('/stream')
async def logs_stream(since: int = Query(0, ge=0)) -> StreamingResponse:
    async def gen():
        last = since
        while True:
            batch = get_records_since(last, 500)
            for rec in batch:
                yield f'data: {json.dumps(rec)}\n\n'
                last = rec['seq']
            await asyncio.sleep(0.2)

    return StreamingResponse(gen(), media_type='text/event-stream')


@router.post('/level')
async def logs_level(request: LogLevelRequest) -> dict[str, bool]:
    set_nemo_log_level(request.level)
    return {'ok': True}


@router.post('/ingest')
async def logs_ingest_route(request: LogIngestRequest) -> dict[str, bool]:
    log_ingest(request.level, request.logger, request.message, request.source)
    return {'ok': True}
