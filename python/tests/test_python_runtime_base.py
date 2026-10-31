"""Tests for durable base-Python selection when reinstalling the runtime venv."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps.paths import venv_python, venv_unusable_reason
from clara_coder_backend.runtime.deps.providers import python_runtime as pr


@pytest.fixture(autouse=True)
def _clear_bundled_runtime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('CLARA_BUNDLED_PYTHON', raising=False)
    monkeypatch.delenv('CLARA_BUNDLED_RUNTIME_DIR', raising=False)
    monkeypatch.delenv('NEMO_BUNDLED_PYTHON', raising=False)
    monkeypatch.delenv('NEMO_BUNDLED_RUNTIME_DIR', raising=False)
    monkeypatch.setattr(pr, '_BUNDLED_CORE_OK', None)


def _stub_bundled_exe(tmp_path: Path) -> Path:
    home = tmp_path / 'runtime-python'
    home.mkdir(parents=True, exist_ok=True)
    exe = home / ('python.exe' if sys.platform.startswith('win') else 'python3')
    exe.write_text('', encoding='utf-8')
    return exe


def _venv_exe(root: Path) -> Path:
    return root / ('Scripts' if sys.platform.startswith('win') else 'bin') / (
        'python.exe' if sys.platform.startswith('win') else 'python'
    )


def _fake_base_home(tmp_path: Path) -> Path:
    """Directory a venv's ``pyvenv.cfg`` ``home =`` can point at (stub interpreter inside)."""
    home = tmp_path / 'base-python'
    home.mkdir(parents=True, exist_ok=True)
    (home / ('python.exe' if sys.platform.startswith('win') else 'python3')).write_text('', encoding='utf-8')
    return home


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
    (venv / 'pyvenv.cfg').write_text(f'home = {_fake_base_home(tmp_path)}\n', encoding='utf-8')
    assert venv_python(venv) == py


def test_venv_python_none_when_base_interpreter_gone(tmp_path: Path) -> None:
    """Windows venv launcher exits 103 "No Python at '…'" when ``home`` no longer exists."""
    venv = tmp_path / 'python-venv'
    py = _venv_exe(venv)
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')
    gone = tmp_path / 'Programs' / 'Clara Coder' / 'resources' / 'runtime-python'
    (venv / 'pyvenv.cfg').write_text(
        f'home = {gone}\ninclude-system-site-packages = false\nversion = 3.12.11\n'
        f'executable = {gone / "python.exe"}\n',
        encoding='utf-8',
    )
    assert venv_python(venv) is None
    reason = venv_unusable_reason(venv)
    assert reason is not None
    assert 'base interpreter missing' in reason
    assert str(gone) in reason


def test_venv_usable_when_pyvenv_cfg_has_no_home(tmp_path: Path) -> None:
    venv = tmp_path / 'python-venv'
    py = _venv_exe(venv)
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')
    (venv / 'pyvenv.cfg').write_text('version = 3.12.11\n', encoding='utf-8')
    assert venv_unusable_reason(venv) is None
    assert venv_python(venv) == py


def test_status_reports_error_when_base_interpreter_gone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    venv = tmp_path / 'python-venv'
    py = _venv_exe(venv)
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')
    gone = tmp_path / 'gone-runtime-python'
    (venv / 'pyvenv.cfg').write_text(f'home = {gone}\n', encoding='utf-8')
    monkeypatch.setattr(pr, 'get_runtime_python_dir', lambda: venv)

    st = pr.status()
    assert st['state'] == 'error'
    assert 'base interpreter missing' in (st.get('error') or '')
    assert 'Download' not in (st.get('error') or '')  # No Dependencies row offers it any more.


def test_install_recreates_venv_when_base_interpreter_gone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv = tmp_path / 'python-venv'
    stub = _venv_exe(venv)
    stub.parent.mkdir(parents=True)
    stub.write_text('', encoding='utf-8')
    gone = tmp_path / 'gone-runtime-python'
    (venv / 'pyvenv.cfg').write_text(f'home = {gone}\n', encoding='utf-8')
    (venv / '.clara-ready').write_text('3.12.11\n', encoding='utf-8')

    durable = _fake_base_home(tmp_path) / ('python.exe' if sys.platform.startswith('win') else 'python3')

    monkeypatch.setattr(pr, 'get_runtime_python_dir', lambda: venv)
    monkeypatch.setattr(pr, '_base_python', lambda _v: str(durable))
    monkeypatch.setattr(pr, '_base_has_core', lambda _base: False)
    monkeypatch.setattr(pr, '_pip_install_requirements', lambda _py, _dep_id: None)
    monkeypatch.setattr(pr, '_write_requirements_hash', lambda _v: None)
    monkeypatch.setattr(pr, '_interpreter_version', lambda _py: '3.12.11')
    monkeypatch.setattr(pr, 'write_ready_marker', lambda _v, _ver: None)
    monkeypatch.setattr(pr, 'status', lambda: {'id': 'python-runtime', 'state': 'installed'})
    # Must never be asked: the stale launcher cannot run.
    monkeypatch.setattr(
        pr, '_core_packages_importable', lambda _py: pytest.fail('stale venv python must not be executed')
    )

    saw_venv_create = {'ok': False}

    def fake_run_streaming(args, **_kwargs):  # type: ignore[no-untyped-def]
        argv = [str(a) for a in args]
        if '-m' in argv and 'venv' in argv:
            assert argv[0] == str(durable)
            assert not (venv / 'pyvenv.cfg').exists(), 'stale venv should be wiped before python -m venv'
            saw_venv_create['ok'] = True
            py = _venv_exe(venv)
            py.parent.mkdir(parents=True)
            py.write_text('', encoding='utf-8')
            (venv / 'pyvenv.cfg').write_text(f'home = {durable.parent}\n', encoding='utf-8')
        return subprocess.CompletedProcess(args, 0, '', '')

    monkeypatch.setattr(pr, 'run_streaming', fake_run_streaming)
    events = _capture_progress(monkeypatch)
    result = pr.install(dep_id='kokoro')
    assert saw_venv_create['ok'] is True
    assert result['state'] == 'installed'
    # Progress belongs to the calling install, which keeps going after the venv step.
    assert events and all(e['depId'] == 'kokoro' and e['phase'] == 'installing' for e in events)


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
    monkeypatch.setattr(pr, '_base_has_core', lambda _base: False)
    pip_called = {'ok': False}

    def fake_pip(_py: Path, _dep_id: str) -> None:
        pip_called['ok'] = True

    monkeypatch.setattr(pr, '_pip_install_requirements', fake_pip)
    monkeypatch.setattr(pr, '_write_requirements_hash', lambda _v: None)
    monkeypatch.setattr(pr, '_interpreter_version', lambda _py: '3.12.0')
    monkeypatch.setattr(pr, 'write_ready_marker', lambda _v, _ver: None)
    monkeypatch.setattr(pr, 'status', lambda: {'id': 'python-runtime', 'state': 'installed'})

    saw_venv_create = {'ok': False}

    def fake_run_streaming(args, **_kwargs):  # type: ignore[no-untyped-def]
        argv = [str(a) for a in args]
        if '-m' in argv and 'venv' in argv:
            assert not stub.exists(), 'incomplete venv stub should be removed before python -m venv'
            assert '--system-site-packages' not in argv
            saw_venv_create['ok'] = True
            py = _venv_exe(venv)
            py.parent.mkdir(parents=True)
            py.write_text('', encoding='utf-8')
            (venv / 'pyvenv.cfg').write_text(f'home = {durable.parent}\n', encoding='utf-8')
        return subprocess.CompletedProcess(args, 0, '', '')

    monkeypatch.setattr(pr, 'run_streaming', fake_run_streaming)
    result = pr.install(dep_id='kokoro')
    assert saw_venv_create['ok'] is True
    assert pip_called['ok'] is True
    assert result['state'] == 'installed'


def test_base_python_uses_bundled_exe_and_ignores_other_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / 'python-venv'
    bundled = _stub_bundled_exe(tmp_path)
    other = tmp_path / 'other-python'
    other.write_text('#!/bin/sh\n', encoding='utf-8')
    other.chmod(0o755)

    monkeypatch.setenv('CLARA_BUNDLED_PYTHON', str(bundled))
    monkeypatch.setenv('CLARA_PYTHON', str(other))
    monkeypatch.setenv('PYTHON', str(other))
    monkeypatch.setattr(pr.sys, 'executable', str(other))
    monkeypatch.setattr(pr.sys, '_base_executable', str(other), raising=False)
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: str(other))

    assert Path(pr._base_python(target)).resolve() == bundled.resolve()


def test_base_python_raises_when_bundled_exe_is_inside_target_venv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / 'python-venv'
    inside = _venv_exe(target)
    inside.parent.mkdir(parents=True)
    inside.write_text('#!/bin/sh\n', encoding='utf-8')
    inside.chmod(0o755)

    other = tmp_path / 'other-python'
    other.write_text('#!/bin/sh\n', encoding='utf-8')
    other.chmod(0o755)

    monkeypatch.setenv('CLARA_BUNDLED_PYTHON', str(inside))
    monkeypatch.setenv('PYTHON', str(other))
    monkeypatch.setattr(pr.shutil, 'which', lambda _name: str(other))

    with pytest.raises(RuntimeError, match='durable Python'):
        pr._base_python(target)


def test_venv_unusable_when_home_is_not_bundled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = _stub_bundled_exe(tmp_path)
    monkeypatch.setenv('CLARA_BUNDLED_PYTHON', str(bundled))

    venv = tmp_path / 'python-venv'
    py = _venv_exe(venv)
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')
    other = _fake_base_home(tmp_path)
    (venv / 'pyvenv.cfg').write_text(f'home = {other}\n', encoding='utf-8')

    reason = venv_unusable_reason(venv)
    assert reason is not None
    assert 'not created from the bundled runtime' in reason
    assert venv_python(venv) is None


def test_venv_usable_when_home_is_bundled_exe_parent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = _stub_bundled_exe(tmp_path)
    monkeypatch.setenv('CLARA_BUNDLED_PYTHON', str(bundled))

    venv = tmp_path / 'python-venv'
    py = _venv_exe(venv)
    py.parent.mkdir(parents=True)
    py.write_text('', encoding='utf-8')
    (venv / 'pyvenv.cfg').write_text(f'home = {bundled.parent}\n', encoding='utf-8')

    assert venv_unusable_reason(venv) is None
    assert venv_python(venv) == py


def test_install_bundled_mode_uses_system_site_packages_and_skips_pip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv = tmp_path / 'python-venv'
    bundled = _stub_bundled_exe(tmp_path)
    monkeypatch.setenv('CLARA_BUNDLED_PYTHON', str(bundled))
    monkeypatch.setattr(pr, 'get_runtime_python_dir', lambda: venv)
    monkeypatch.setattr(
        pr,
        '_pip_install_requirements',
        lambda _py, _dep_id: pytest.fail('must not pip-install core packages in bundled mode'),
    )
    monkeypatch.setattr(pr, '_write_requirements_hash', lambda _v: None)
    monkeypatch.setattr(pr, '_interpreter_version', lambda _py: '3.12.11')
    monkeypatch.setattr(pr, 'write_ready_marker', lambda _v, _ver: None)
    monkeypatch.setattr(pr, 'status', lambda: {'id': 'python-runtime', 'state': 'installed'})

    saw_venv_create = {'ok': False}

    def fake_run_streaming(args, **_kwargs):  # type: ignore[no-untyped-def]
        argv = [str(a) for a in args]
        if '-m' in argv and 'venv' in argv:
            assert '--system-site-packages' in argv
            assert argv[0] == str(Path(pr._base_python(venv)))
            saw_venv_create['ok'] = True
            py = _venv_exe(venv)
            py.parent.mkdir(parents=True)
            py.write_text('', encoding='utf-8')
            (venv / 'pyvenv.cfg').write_text(f'home = {bundled.parent}\n', encoding='utf-8')
        return subprocess.CompletedProcess(args, 0, '', '')

    monkeypatch.setattr(pr, 'run_streaming', fake_run_streaming)
    result = pr.install(dep_id='kokoro')
    assert saw_venv_create['ok'] is True
    assert result['state'] == 'installed'


def test_status_bundled_installed_without_overlay_venv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = _stub_bundled_exe(tmp_path)
    (bundled.parent / '.clara-runtime-manifest.json').write_text(
        json.dumps({'schemaVersion': 1, 'pythonVersion': '3.12.11'}),
        encoding='utf-8',
    )
    monkeypatch.setenv('CLARA_BUNDLED_PYTHON', str(bundled))
    monkeypatch.setenv('CLARA_BUNDLED_RUNTIME_DIR', str(bundled.parent))
    monkeypatch.setattr(pr, 'get_runtime_python_dir', lambda: tmp_path / 'python-venv')
    monkeypatch.setattr(pr, '_base_has_core', lambda _exe: True)

    st = pr.status()
    assert st['state'] == 'installed'
    assert st['path'] == str(bundled)
    assert st.get('error') is None
    assert st['version'] == '3.12.11'


def test_expected_requirements_hash_uses_manifest_when_bundled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = _stub_bundled_exe(tmp_path)
    digest = 'ab' * 32
    (bundled.parent / '.clara-runtime-manifest.json').write_text(
        json.dumps(
            {
                'schemaVersion': 1,
                'pythonVersion': '3.12.11',
                'requirementsSha256': digest,
            }
        ),
        encoding='utf-8',
    )
    req = tmp_path / 'requirements.txt'
    req.write_text('fastapi\nsomething-else\n', encoding='utf-8')
    monkeypatch.setenv('CLARA_BUNDLED_PYTHON', str(bundled))
    monkeypatch.setenv('CLARA_BUNDLED_RUNTIME_DIR', str(bundled.parent))
    monkeypatch.setattr(pr, 'requirements_txt', lambda: req)

    assert pr._expected_requirements_hash() == digest
    assert pr._requirements_fingerprint() != digest


def test_registry_does_not_list_the_python_runtime() -> None:
    from clara_coder_backend.runtime.deps import registry

    assert 'python-runtime' not in registry.DEPENDENCY_IDS
    assert set(registry._providers()) == set(registry.DEPENDENCY_IDS)


def test_registry_attaches_components_to_status(monkeypatch: pytest.MonkeyPatch) -> None:
    from clara_coder_backend.runtime.deps import registry

    class FakeProvider:
        DEP_ID = 'kokoro'

        @staticmethod
        def status() -> dict:
            return {'id': 'kokoro', 'state': 'missing'}

        @staticmethod
        def components() -> list[str]:
            return ['torch (CPU)', '', 'kokoro']

    class NoComponentsProvider:
        @staticmethod
        def status() -> dict:
            return {'id': 'java-lsp', 'state': 'missing'}

    monkeypatch.setattr(
        registry,
        '_providers',
        lambda: {'kokoro': FakeProvider, 'java-lsp': NoComponentsProvider},
    )
    assert registry.get_dependency('kokoro')['components'] == ['torch (CPU)', 'kokoro']
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
    pr._pip_install_requirements(tmp_path / 'python', 'whisper')

    assert len(calls) == 1
    assert calls[0]['args'][1:] == ['-m', 'pip', 'install', '-r', str(req)]
    assert calls[0]['dep_id'] == 'whisper'

