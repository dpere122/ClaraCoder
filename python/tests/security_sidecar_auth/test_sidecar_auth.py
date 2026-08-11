"""Tests for security/python-sidecar-auth — subtasks 1 & 2.

Verifies the FastAPI sidecar bearer-token auth gate: protected routes reject
missing/wrong tokens with 401, correct tokens pass, and ``/health`` is the
auth-exempt echo endpoint returning the non-secret ``x_clara_sidecar`` marker.
"""
from __future__ import annotations

import hashlib

import pytest
from starlette.testclient import TestClient

_TOKEN = 'testtoken123'


@pytest.fixture()
def auth_on(monkeypatch):
    """Enable sidecar auth with a known token (fail-closed, not optional)."""
    monkeypatch.setenv('CLARA_SIDECAR_TOKEN', _TOKEN)
    monkeypatch.delenv('CLARA_SIDECAR_AUTH_OPTIONAL', raising=False)


def _client():
    from clara_coder_backend.main import app
    return TestClient(app)


def test_protected_route_rejects_missing_token(auth_on) -> None:
    with _client() as client:
        assert client.get('/auth-probe').status_code == 401


def test_protected_route_rejects_wrong_token(auth_on) -> None:
    with _client() as client:
        r = client.get('/auth-probe', headers={'Authorization': 'Bearer wrong'})
        assert r.status_code == 401


def test_protected_route_accepts_correct_token(auth_on) -> None:
    with _client() as client:
        r = client.get('/auth-probe', headers={'Authorization': f'Bearer {_TOKEN}'})
        # Auth middleware passes; the router then 404s the unknown path.
        assert r.status_code != 401


def test_health_is_auth_exempt(auth_on) -> None:
    with _client() as client:
        # /health is exempt: reachable even without a token.
        assert client.get('/health').status_code == 200


def test_health_marker_is_sha256_prefix_not_raw_token(auth_on) -> None:
    with _client() as client:
        r = client.get('/health', headers={'Authorization': f'Bearer {_TOKEN}'})
        assert r.status_code == 200
        body = r.json()
        marker = body.get('x_clara_sidecar')
        assert marker, 'missing x_clara_sidecar marker in body'
        assert marker != _TOKEN, 'marker must not leak the raw token'
        assert marker == hashlib.sha256(_TOKEN.encode()).hexdigest()[:16]


def test_auth_optional_disables_gate(monkeypatch) -> None:
    monkeypatch.delenv('CLARA_SIDECAR_TOKEN', raising=False)
    monkeypatch.setenv('CLARA_SIDECAR_AUTH_OPTIONAL', '1')
    with _client() as client:
        # With auth opted out, even a protected route is reachable (no 401).
        assert client.get('/auth-probe').status_code != 401
