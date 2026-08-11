"""Tests for security/python-sidecar-auth — subtask 5 (ssrf-dns-rebind-pin).

Verifies ``resolve_public_http_url`` returns a pinned public IP for public
hosts and blocks loopback / private / link-local / metadata / credentials /
non-http / empty URLs (SSRF).
"""
from __future__ import annotations

import pytest

from clara_coder_backend.tools.http_guards import (
    assert_public_http_url,
    resolve_public_http_url,
)


def test_public_host_returns_pinned_ip() -> None:
    ip, err = resolve_public_http_url('http://example.com/')
    assert err is None
    assert ip is not None


@pytest.mark.parametrize(
    'url',
    [
        'http://127.0.0.1/',
        'http://localhost/',
        'http://10.0.0.5/',
        'http://192.168.1.1/',
        'http://172.16.0.1/',
        'http://169.254.169.254/',
        'http://[::1]/',
        'http://[fe80::1]/',
    ],
)
def test_private_hosts_blocked(url: str) -> None:
    ip, err = resolve_public_http_url(url)
    assert ip is None
    assert err is not None
    assert 'non-public' in err


def test_non_http_scheme_blocked() -> None:
    assert 'must use http or https' in assert_public_http_url('ftp://example.com/')


def test_credentials_in_url_blocked() -> None:
    assert 'must not include credentials' in assert_public_http_url(
        'http://user:pass@example.com/'
    )


def test_empty_url_blocked() -> None:
    assert 'must not be empty' in assert_public_http_url('')
