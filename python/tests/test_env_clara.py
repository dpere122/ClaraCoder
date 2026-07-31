"""Tests for CLARA_* / legacy NEMO_* env dual-read."""

from __future__ import annotations

from clara_coder_backend.session.config import env_clara


def test_env_clara_prefers_clara_over_nemo(monkeypatch):
    monkeypatch.setenv('CLARA_LOG_DIR', '/clara/logs')
    monkeypatch.setenv('NEMO_LOG_DIR', '/nemo/logs')
    assert env_clara('LOG_DIR') == '/clara/logs'
    assert env_clara('CLARA_LOG_DIR') == '/clara/logs'


def test_env_clara_falls_back_to_nemo(monkeypatch):
    monkeypatch.delenv('CLARA_STAGING_DIR', raising=False)
    monkeypatch.setenv('NEMO_STAGING_DIR', '/legacy/staging')
    assert env_clara('STAGING_DIR') == '/legacy/staging'


def test_env_clara_default_when_unset(monkeypatch):
    monkeypatch.delenv('CLARA_CHECKPOINT_DB', raising=False)
    monkeypatch.delenv('NEMO_CHECKPOINT_DB', raising=False)
    assert env_clara('CHECKPOINT_DB', 'default.sqlite') == 'default.sqlite'
