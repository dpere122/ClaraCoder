"""Tests for unified app logging and log HTTP surface."""

from __future__ import annotations

import importlib
import logging
import os
import tempfile
import unittest
from pathlib import Path


class TestAppLoggingHttp(unittest.TestCase):
    def setUp(self) -> None:
        import clara_coder_backend.logging.app_logging as app_logging

        app_logging._configured = False  # type: ignore[attr-defined]
        app_logging._ring.clear()  # type: ignore[attr-defined]
        self._td = tempfile.TemporaryDirectory()
        os.environ['CLARA_LOG_DIR'] = self._td.name
        import clara_coder_backend.main as main_mod

        importlib.reload(main_mod)
        self._main = main_mod
        from fastapi.testclient import TestClient

        self.client = TestClient(main_mod.app)

    def tearDown(self) -> None:
        self.client.close()
        from clara_coder_backend.logging.app_logging import reset_logging_handlers

        reset_logging_handlers()
        self._td.cleanup()
        os.environ.pop('CLARA_LOG_DIR', None)

    def test_recent_after_info_log(self) -> None:
        logging.getLogger('clara.test').info('hello health')
        r = self.client.get('/logs/recent?limit=50')
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn('records', data)
        texts = ' '.join(x.get('message', '') for x in data['records'])
        self.assertIn('hello health', texts)
        self.assertTrue((Path(self._td.name) / 'clara-app.log').exists())

    def test_ingest(self) -> None:
        self.client.post(
            '/logs/ingest',
            json={
                'level': 'WARNING',
                'logger': 'clara.electron.test',
                'message': 'from electron',
                'source': 'electron',
            },
        )
        r = self.client.get('/logs/recent?limit=10')
        msgs = [x['message'] for x in r.json()['records']]
        self.assertIn('from electron', msgs)


if __name__ == '__main__':
    unittest.main()
