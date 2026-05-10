"""Tests for :mod:`nemo_backend.http_url_normalize`."""

from __future__ import annotations

from nemo_backend.http_url_normalize import normalize_bind_all_host_url


def test_normalize_bind_all_ipv4() -> None:
    assert normalize_bind_all_host_url('http://0.0.0.0:8081/v1') == 'http://127.0.0.1:8081/v1'


def test_normalize_bind_all_ipv6_unspecified() -> None:
    assert normalize_bind_all_host_url('http://[::]:9000/v1') == 'http://127.0.0.1:9000/v1'


def test_normalize_preserves_lan_host() -> None:
    assert normalize_bind_all_host_url('http://192.168.1.50:8080/v1') == 'http://192.168.1.50:8080/v1'


def test_normalize_schemeless() -> None:
    assert normalize_bind_all_host_url('0.0.0.0:7777/v1') == 'http://127.0.0.1:7777/v1'
