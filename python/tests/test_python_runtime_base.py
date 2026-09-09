"""Tests for durable base-Python selection when reinstalling the runtime venv."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps.paths import venv_python
from clara_coder_backend.runtime.deps.providers import python_runtime as pr


def _venv_exe(root: Path) -> Path:
    return root / ('Scripts' if sys.platform.startswith('win') else 'bin') / (
        'python.exe' if sys.platform.startswith('win') else 'python'
    )


def test_base_python_skips_interpreter_inside_target_venv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    inside = target / 'bin' / 'python'
    inside.parent.mkdir(parents=True)
    inside.write_text('#!/bin/sh\n', encoding='utf-8')
    inside.chmod(0o755)

    durable = tmp_path / 'portable' / 'python'
    durable.parent.mkdir(parents=True)
    durable.write_text('#!/bin/sh\n', encoding='utf-8')
    durable.chmod(0o755)

    monkeypatch.setattr(pr.sys, 'executable', str(inside))
    monkeypatch.setattr(pr.sys, '_base_executable', str(durable), raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)
    monkeypatch.setenv('CLARA_PYTHON', '')
    monkeypatch.setenv('PYTHON', '')

    assert Path(pr._base_python(target)).resolve() == durable.resolve()


def test_base_python_prefers_clara_python_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    override = tmp_path / 'override-python'
    override.write_text('#!/bin/sh\n', encoding='utf-8')
    override.chmod(0o755)

    monkeypatch.setenv('CLARA_PYTHON', str(override))
    monkeypatch.setattr(pr.sys, 'executable', str(tmp_path / 'missing'))
    monkeypatch.setattr(pr.sys, '_base_executable', '', raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)

    assert Path(pr._base_python(target)).resolve() == override.resolve()


def test_base_python_reads_bare_python_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    override = tmp_path / 'python-from-env'
    override.write_text('#!/bin/sh\n', encoding='utf-8')
    override.chmod(0o755)

    monkeypatch.delenv('CLARA_PYTHON', raising=False)
    monkeypatch.delenv('NEMO_PYTHON', raising=False)
    monkeypatch.setenv('PYTHON', str(override))
    monkeypatch.setattr(pr.sys, 'executable', str(tmp_path / 'missing'))
    monkeypatch.setattr(pr.sys, '_base_executable', '', raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)

    assert Path(pr._base_python(target)).resolve() == override.resolve()


def test_base_python_errors_when_only_target_venv_exists(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / 'python-venv'
    inside = target / 'bin' / 'python'
    inside.parent.mkdir(parents=True)
    inside.write_text('#!/bin/sh\n', encoding='utf-8')
    inside.chmod(0o755)

    monkeypatch.delenv('CLARA_PYTHON', raising=False)
    monkeypatch.delenv('PYTHON', raising=False)
    monkeypatch.setattr(pr.sys, 'executable', str(inside))
    monkeypatch.setattr(pr.sys, '_base_executable', str(inside), raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: None)

    with pytest.raises(RuntimeError, match='durable Python'):
        pr._base_python(target)


def test_requirements_fingerprint_changes_with_file_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    req = tmp_path / 'requirements.txt'
    req.write_text('fastapi\n', encoding='utf-8')
    monkeypatch.setattr(pr, 'requirements_txt', lambda: req)
    first = pr._requirements_fingerprint()
    req.write_text('fastapi\nbasedpyright\n', encoding='utf-8')
    second = pr._requirements_fingerprint()
    assert first != second
    assert len(first) == 64


def test_requirements_current_false_until_hash_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    req = tmp_path / 'requirements.txt'
    req.write_text('basedpyright>=1.29,<1.40\n', encoding='utf-8')
    monkeypatch.setattr(pr, 'requirements_txt', lambda: req)
    venv = tmp_path / 'python-venv'
    venv.mkdir()
    assert pr._requirements_current(venv) is False
    pr._write_requirements_hash(venv)
    assert pr._requirements_current(venv) is True
    req.write_text('basedpyright>=1.29,<1.40\nblack\n', encoding='utf-8')
    assert pr._requirements_current(venv) is False


def test_status_reports_error_when_requirements_hash_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv = tmp_path / 'python-venv'
    venv.mkdir()
    py = venv / ('Scripts' if sys.platform.startswith('win') else 'bin') / (
        'python.exe' if sys.platform.startswith('win') else 'python'
    )
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')

    req = tmp_path / 'requirements.txt'
    req.write_text('fastapi\nbasedpyright\n', encoding='utf-8')
    monkeypatch.setattr(pr, 'get_runtime_python_dir', lambda: venv)
    monkeypatch.setattr(pr, 'venv_python', lambda _venv: py)
    monkeypatch.setattr(pr, 'read_ready_marker', lambda _venv: '3.12.0')
    monkeypatch.setattr(pr, 'requirements_txt', lambda: req)
    monkeypatch.setattr(pr, '_core_packages_importable', lambda _py: True)

    st = pr.status()
    assert st['state'] == 'error'
    assert 'requirements.txt changed' in (st.get('error') or '')


def test_status_installed_when_core_packages_and_hash_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv = tmp_path / 'python-venv'
    venv.mkdir()
    py = venv / ('Scripts' if sys.platform.startswith('win') else 'bin') / (
        'python.exe' if sys.platform.startswith('win') else 'python'
    )
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')

    req = tmp_path / 'requirements.txt'
    req.write_text('fastapi\n', encoding='utf-8')
    monkeypatch.setattr(pr, 'get_runtime_python_dir', lambda: venv)
    monkeypatch.setattr(pr, 'venv_python', lambda _venv: py)
    monkeypatch.setattr(pr, 'read_ready_marker', lambda _venv: '3.12.0')
    monkeypatch.setattr(pr, 'requirements_txt', lambda: req)
    monkeypatch.setattr(pr, '_core_packages_importable', lambda _py: True)
    pr._write_requirements_hash(venv)

    st = pr.status()
    assert st['state'] == 'installed'
    assert st.get('error') is None


def test_venv_python_none_without_pyvenv_cfg(tmp_path: Path) -> None:
    venv = tmp_path / 'python-venv'
    py = _venv_exe(venv)
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')
    assert venv_python(venv) is None
    (venv / 'pyvenv.cfg').write_text('home = /tmp\n', encoding='utf-8')
    assert venv_python(venv) == py


def test_install_wipes_incomplete_venv_missing_pyvenv_cfg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv = tmp_path / 'python-venv'
    stub = _venv_exe(venv)
    stub.parent.mkdir(parents=True)
    stub.write_text('', encoding='utf-8')

    durable = tmp_path / 'portable' / ('python.exe' if sys.platform.startswith('win') else 'python')
    durable.parent.mkdir(parents=True)
    durable.write_text('', encoding='utf-8')

    monkeypatch.setattr(pr, 'get_runtime_python_dir', lambda: venv)
    monkeypatch.setattr(pr, '_base_python', lambda _v: str(durable))
    monkeypatch.setattr(pr, '_pip_install_requirements', lambda _py: None)
    monkeypatch.setattr(pr, '_write_requirements_hash', lambda _v: None)
    monkeypatch.setattr(pr, '_interpreter_version', lambda _py: '3.12.0')
    monkeypatch.setattr(pr, 'write_ready_marker', lambda _v, _ver: None)
    monkeypatch.setattr(pr, 'status', lambda: {'id': 'python-runtime', 'state': 'installed'})

    saw_venv_create = {'ok': False}

    def fake_run_streaming(args, **_kwargs):  # type: ignore[no-untyped-def]
        argv = [str(a) for a in args]
        if '-m' in argv and 'venv' in argv:
            assert not stub.exists(), 'incomplete venv stub should be removed before python -m venv'
            saw_venv_create['ok'] = True
            py = _venv_exe(venv)
            py.parent.mkdir(parents=True)
            py.write_text('', encoding='utf-8')
            (venv / 'pyvenv.cfg').write_text('home = /tmp\n', encoding='utf-8')
        return subprocess.CompletedProcess(args, 0, '', '')

    monkeypatch.setattr(pr, 'run_streaming', fake_run_streaming)
    result = pr.install(force=False)
    assert saw_venv_create['ok'] is True
    assert result['state'] == 'installed'


def test_requirement_names_strips_specifiers_comments_and_options() -> None:
    text = (
        '# Interpreter: Python 3.10–3.13\n'
        'fastapi>=0.135,<1\n'
        'typing-extensions>=4.12,<5  # inline comment\n'
        'uvicorn[standard]>=0.42\n'
        '--extra-index-url https://example.invalid/simple\n'
        '-r other.txt\n'
        'pkg @ https://example.invalid/pkg.whl\n'
        'markered==1.0; python_version < "3.13"\n'
        '\n'
        'fastapi\n'  # duplicate collapses
    )
    assert pr.requirement_names(text) == [
        'fastapi',
        'typing-extensions',
        'uvicorn',
        'pkg',
        'markered',
    ]


def test_components_lists_venv_pip_then_requirements(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    req = tmp_path / 'requirements.txt'
    req.write_text('fastapi>=0.1\nuvicorn\n', encoding='utf-8')
    monkeypatch.setattr(pr, 'requirements_txt', lambda: req)
    assert pr.components() == ['venv', 'pip', 'fastapi', 'uvicorn']

    monkeypatch.setattr(pr, 'requirements_txt', lambda: tmp_path / 'missing.txt')
    assert pr.components() == ['venv', 'pip']


def test_registry_attaches_components_to_status(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.runtime.deps import registry

    class FakeProvider:
        DEP_ID = 'python-runtime'

        @staticmethod
        def status() -> dict:
            return {'id': 'python-runtime', 'state': 'missing'}

        @staticmethod
        def components() -> list[str]:
            return ['venv', 'pip', '', 'fastapi']

    class NoComponentsProvider:
        @staticmethod
        def status() -> dict:
            return {'id': 'java-lsp', 'state': 'missing'}

    monkeypatch.setattr(
        registry,
        '_providers',
        lambda: {'python-runtime': FakeProvider, 'java-lsp': NoComponentsProvider},
    )
    assert registry.get_dependency('python-runtime')['components'] == ['venv', 'pip', 'fastapi']
    assert registry.get_dependency('java-lsp')['components'] == []


def _capture_progress(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    from clara_coder_backend.runtime.deps.progress import PROGRESS

    events: list[dict] = []
    # Replace (not append to) the listener list so the test sees only its own events
    # and monkeypatch restores the original listeners afterwards.
    monkeypatch.setattr(PROGRESS, '_listeners', [events.append])
    return events


def test_run_streaming_forwards_each_output_line_to_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.runtime.deps.download import run_streaming

    events = _capture_progress(monkeypatch)
    script = (
        'import sys; '
        'print("Collecting fastapi"); '
        'print("  Downloading fastapi-0.1.whl (1.0 MB)"); '
        'print("warning: on stderr", file=sys.stderr); '
        'print("")'
    )
    result = run_streaming(
        [sys.executable, '-c', script],
        dep_id='python-runtime',
        label='pip install',
    )

    assert result.returncode == 0
    messages = [e['message'] for e in events]
    assert messages[0].startswith('$ ')
    assert 'Collecting fastapi' in messages
    assert '  Downloading fastapi-0.1.whl (1.0 MB)' in messages
    # stderr is merged into the same stream so warnings reach the log too.
    assert 'warning: on stderr' in messages
    # Blank lines are dropped.
    assert '' not in messages
    assert all(e['depId'] == 'python-runtime' and e['phase'] == 'installing' for e in events)
    assert 'Collecting fastapi' in result.stdout


def test_run_streaming_raises_with_output_tail_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.runtime.deps.download import run_streaming

    events = _capture_progress(monkeypatch)
    script = 'import sys; print("ERROR: No matching distribution"); sys.exit(3)'
    with pytest.raises(RuntimeError, match='exit code 3') as excinfo:
        run_streaming([sys.executable, '-c', script], dep_id='python-runtime', label='pip install')

    assert 'No matching distribution' in str(excinfo.value)
    assert any('exited with code 3' in e['message'] for e in events)


def test_run_streaming_check_false_returns_nonzero(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.runtime.deps.download import run_streaming

    _capture_progress(monkeypatch)
    result = run_streaming(
        [sys.executable, '-c', 'import sys; sys.exit(2)'],
        dep_id='python-runtime',
        label='ensurepip',
        check=False,
    )
    assert result.returncode == 2


def test_pip_install_requirements_streams_via_run_streaming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    req = tmp_path / 'requirements.txt'
    req.write_text('fastapi\n', encoding='utf-8')
    monkeypatch.setattr(pr, 'requirements_txt', lambda: req)

    calls: list[dict] = []

    def fake_run_streaming(args, **kwargs):  # type: ignore[no-untyped-def]
        calls.append({'args': [str(a) for a in args], **kwargs})
        return subprocess.CompletedProcess(args, 0, '', '')

    monkeypatch.setattr(pr, 'run_streaming', fake_run_streaming)
    pr._pip_install_requirements(tmp_path / 'python')

    assert len(calls) == 1
    assert calls[0]['args'][1:] == ['-m', 'pip', 'install', '-r', str(req)]
    assert calls[0]['dep_id'] == 'python-runtime'

