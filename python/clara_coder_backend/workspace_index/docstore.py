"""SQLite-backed LlamaIndex docstore for the workspace semantic index.

``SimpleDocumentStore`` deserializes every chunk's text and metadata into Python
objects on load (a 16 MB ``docstore.json`` cost most of the ~80 MB an index held,
and drove a ~240 MB peak while parsing). Retrieval only needs the top-k chunks, so
this store keeps them in ``docstore.sqlite`` and reads rows on demand.

Writes accumulate in an open transaction and are committed by ``persist()``, matching
``SimpleDocumentStore``'s "nothing on disk until persist" behaviour. Every handle to a
given file is shared through a weak registry, so two index objects for one workspace
never hold competing write transactions, and :func:`release_index_dir` can close all
of them before the directory is deleted or swapped (Windows will not remove open files).
"""

from __future__ import annotations

import gc
import json
import logging
import os
import sqlite3
import threading
import weakref
from pathlib import Path
from typing import Any

from llama_index.core.storage.docstore.keyval_docstore import KVDocumentStore
from llama_index.core.storage.kvstore.types import DEFAULT_BATCH_SIZE, DEFAULT_COLLECTION, BaseKVStore

logger = logging.getLogger('clara.workspace_index.docstore')

DOCSTORE_FNAME = 'docstore.sqlite'
LEGACY_DOCSTORE_FNAME = 'docstore.json'

_SCHEMA = (
    'CREATE TABLE IF NOT EXISTS kv ('
    ' collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,'
    ' PRIMARY KEY (collection, key)) WITHOUT ROWID'
)

_open_stores: weakref.WeakValueDictionary[str, SqliteKVStore] = weakref.WeakValueDictionary()
_open_stores_guard = threading.Lock()


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


class SqliteKVStore(BaseKVStore):
    """``BaseKVStore`` over one SQLite file; thread-safe, writes pending until :meth:`commit`."""

    def __init__(self, db_path: Path) -> None:
        self.path = db_path
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.execute('PRAGMA journal_mode=DELETE')
        self._conn.execute('PRAGMA synchronous=NORMAL')
        self._conn.execute('PRAGMA cache_size=-2048')  # KiB
        self._conn.execute(_SCHEMA)
        self._conn.commit()

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            raise sqlite3.ProgrammingError(f'semantic index docstore {self.path} was closed')
        return self._conn

    def put(self, key: str, val: dict, collection: str = DEFAULT_COLLECTION) -> None:
        self.put_all([(key, val)], collection=collection)

    def put_all(
        self,
        kv_pairs: list[tuple[str, dict]],
        collection: str = DEFAULT_COLLECTION,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        rows = [(collection, key, json.dumps(val)) for key, val in kv_pairs]
        with self._lock:
            self._db().executemany('INSERT OR REPLACE INTO kv (collection, key, value) VALUES (?, ?, ?)', rows)

    def get(self, key: str, collection: str = DEFAULT_COLLECTION) -> dict | None:
        with self._lock:
            row = self._db().execute(
                'SELECT value FROM kv WHERE collection = ? AND key = ?', (collection, key)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def get_all(self, collection: str = DEFAULT_COLLECTION) -> dict[str, dict]:
        with self._lock:
            rows = self._db().execute('SELECT key, value FROM kv WHERE collection = ?', (collection,)).fetchall()
        return {key: json.loads(value) for key, value in rows}

    def delete(self, key: str, collection: str = DEFAULT_COLLECTION) -> bool:
        with self._lock:
            cur = self._db().execute('DELETE FROM kv WHERE collection = ? AND key = ?', (collection, key))
        return cur.rowcount > 0

    async def aput(self, key: str, val: dict, collection: str = DEFAULT_COLLECTION) -> None:
        self.put(key, val, collection)

    async def aput_all(
        self,
        kv_pairs: list[tuple[str, dict]],
        collection: str = DEFAULT_COLLECTION,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        self.put_all(kv_pairs, collection, batch_size)

    async def aget(self, key: str, collection: str = DEFAULT_COLLECTION) -> dict | None:
        return self.get(key, collection)

    async def aget_all(self, collection: str = DEFAULT_COLLECTION) -> dict[str, dict]:
        return self.get_all(collection)

    async def adelete(self, key: str, collection: str = DEFAULT_COLLECTION) -> bool:
        return self.delete(key, collection)

    def commit(self) -> None:
        with self._lock:
            self._db().commit()

    def close(self) -> None:
        """Close without committing; pending writes are rolled back."""
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    @property
    def closed(self) -> bool:
        return self._conn is None


class SqliteDocumentStore(KVDocumentStore):
    """``KVDocumentStore`` whose ``persist()`` commits the SQLite transaction in place."""

    def __init__(self, kvstore: SqliteKVStore) -> None:
        super().__init__(kvstore)
        self.sqlite = kvstore

    def persist(self, persist_path: str | None = None, fs: Any = None) -> None:
        if persist_path is not None:
            target = Path(persist_path).parent
            if _path_key(target) != _path_key(self.sqlite.path.parent):
                raise ValueError(f'docstore lives in {self.sqlite.path.parent}, cannot persist it to {target}')
        self.sqlite.commit()


def _shared_store(db_path: Path) -> SqliteKVStore:
    key = _path_key(db_path)
    with _open_stores_guard:
        store = _open_stores.get(key)
        if store is None or store.closed:
            store = SqliteKVStore(db_path)
            _open_stores[key] = store
        return store


def create_docstore(persist_dir: Path) -> SqliteDocumentStore:
    """New, empty docstore in *persist_dir* (an existing file there is replaced)."""
    persist_dir.mkdir(parents=True, exist_ok=True)
    db_path = persist_dir / DOCSTORE_FNAME
    release_index_dir(persist_dir)
    db_path.unlink(missing_ok=True)
    return SqliteDocumentStore(_shared_store(db_path))


def open_docstore(persist_dir: Path) -> SqliteDocumentStore:
    """Docstore persisted in *persist_dir*, converting a legacy ``docstore.json`` first if needed."""
    db_path = persist_dir / DOCSTORE_FNAME
    if not db_path.is_file():
        legacy = persist_dir / LEGACY_DOCSTORE_FNAME
        if not legacy.is_file():
            raise FileNotFoundError(f'no docstore in {persist_dir}')
        _convert_legacy_docstore(legacy, db_path)
    return SqliteDocumentStore(_shared_store(db_path))


def _convert_legacy_docstore(legacy: Path, db_path: Path) -> None:
    """Copy ``SimpleDocumentStore`` JSON (``{collection: {key: value}}``) into a fresh SQLite file."""
    tmp = db_path.with_name(f'{db_path.name}.tmp')
    tmp.unlink(missing_ok=True)
    with open(legacy, encoding='utf-8') as f:
        collections = json.load(f)
    store = SqliteKVStore(tmp)
    try:
        rows = 0
        for collection, entries in collections.items():
            if isinstance(entries, dict):
                store.put_all(list(entries.items()), collection=collection)
                rows += len(entries)
        del collections
        store.commit()
    finally:
        store.close()
    os.replace(tmp, db_path)
    legacy.unlink(missing_ok=True)
    logger.info('Converted legacy JSON docstore %s to SQLite (%s rows)', legacy, rows)


def release_index_dir(directory: Path) -> None:
    """Close every open docstore handle under *directory* so it can be deleted or renamed."""
    # A store dropped by its last index can leave its ``sqlite3.Connection`` (and the
    # Windows file lock) alive until the cyclic GC runs; collect so those close too.
    gc.collect()
    prefix = _path_key(directory)
    with _open_stores_guard:
        doomed = [
            (key, store)
            for key, store in list(_open_stores.items())
            if key == prefix or key.startswith(prefix + os.sep)
        ]
        for key, _store in doomed:
            _open_stores.pop(key, None)
    for _key, store in doomed:
        store.close()


def close_docstore(docstore: Any) -> None:
    """Close *docstore* if it is a :class:`SqliteDocumentStore` (no-op otherwise)."""
    if isinstance(docstore, SqliteDocumentStore):
        with _open_stores_guard:
            key = _path_key(docstore.sqlite.path)
            if _open_stores.get(key) is docstore.sqlite:
                _open_stores.pop(key, None)
        docstore.sqlite.close()
