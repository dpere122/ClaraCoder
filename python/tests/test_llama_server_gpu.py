"""Tests for NVIDIA/CUDA detection and llama-server variant selection."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from clara_coder_backend.runtime.deps.providers import gpu_detect, llama_server as ls


# --------------------------------------------------------------------------- #
# gpu_detect.detect_nvidia_gpu
# --------------------------------------------------------------------------- #


def _fake_run_factory(*, stdout: str = '', returncode: int = 0, raises: bool = False):
    """Build a fake subprocess.run replacement for gpu_detect._run.

    The real ``_run`` returns a ``(returncode, stdout, stderr)`` tuple and swallows
    ``FileNotFoundError`` (returning ``(-1, '', '')``). ``raises`` mimics that.
    """

    def fake_run(cmd, *, timeout=None, **kwargs):
        if raises:
            return (-1, '', '')
        return (returncode, stdout, '')

    return fake_run


def test_detect_nvidia_gpu_absent_when_nvidia_smi_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gpu_detect, '_run', _fake_run_factory(raises=True))
    monkeypatch.setattr(gpu_detect, '_cu_driver_get_version', lambda: None)
    info = gpu_detect.detect_nvidia_gpu()
    assert info.present is False
    assert info.gpu_names == ()
    assert info.cuda_runtime is None


def test_detect_nvidia_gpu_parses_smi_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    smi_out = "NVIDIA GeForce RTX 4070, 560.35\nNVIDIA GeForce RTX 4090, 560.35\n"
    monkeypatch.setattr(gpu_detect, '_run', _fake_run_factory(stdout=smi_out))
    monkeypatch.setattr(gpu_detect, '_cu_driver_get_version', lambda: (12, 4))
    info = gpu_detect.detect_nvidia_gpu()
    assert info.present is True
    assert info.gpu_names == ('NVIDIA GeForce RTX 4070', 'NVIDIA GeForce RTX 4090')
    assert info.driver_version == '560.35'
    assert info.cuda_runtime == (12, 4)
    assert info.cuda_major == 12


def test_detect_nvidia_gpu_falls_back_to_smi_table_for_cuda_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    smi_csv = "NVIDIA GeForce RTX 4070, 560.35\n"
    smi_table = "+-----------------------------------------------------------------------------+\n"
    smi_table += "| NVIDIA-SMI 560.35    Driver Version: 560.35    CUDA Version: 13.3        OK |\n"

    def fake_run(cmd, *, timeout=None, **kwargs):
        if any('--query-gpu' in arg for arg in cmd):
            return (0, smi_csv, '')
        return (0, smi_table, '')

    monkeypatch.setattr(gpu_detect, '_run', fake_run)
    monkeypatch.setattr(gpu_detect, '_cu_driver_get_version', lambda: None)
    info = gpu_detect.detect_nvidia_gpu()
    assert info.present is True
    assert info.cuda_runtime == (13, 3)


def test_cu_driver_get_version_returns_none_when_library_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ctypes

    def raise_oserror(*args, **kwargs):
        raise OSError('no nvcuda')

    monkeypatch.setattr(ctypes, 'WinDLL', raise_oserror, raising=False)
    monkeypatch.setattr(ctypes, 'CDLL', raise_oserror, raising=False)
    assert gpu_detect._cu_driver_get_version() is None


# --------------------------------------------------------------------------- #
# gpu_detect.detect_build_toolchain
# --------------------------------------------------------------------------- #


def test_build_toolchain_available_when_all_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(gpu_detect.shutil, 'which', lambda name: {
        'cmake': '/usr/bin/cmake',
        'gcc': '/usr/bin/gcc',
        'cc': None,
        'nvcc': '/usr/local/cuda/bin/nvcc',
    }.get(name))
    # Pin CUDA_HOME so the result does not depend on host symlink resolution.
    monkeypatch.setenv('CUDA_HOME', '/usr/local/cuda')
    monkeypatch.delenv('CUDA_PATH', raising=False)
    tc = gpu_detect.detect_build_toolchain()
    assert tc.available is True
    assert tc.missing == ()
    assert tc.cmake_path == '/usr/bin/cmake'
    assert tc.nvcc_path == '/usr/local/cuda/bin/nvcc'
    assert tc.cuda_home == '/usr/local/cuda'


def test_build_toolchain_reports_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gpu_detect.shutil, 'which', lambda _name: None)
    monkeypatch.delenv('CUDA_HOME', raising=False)
    monkeypatch.delenv('CUDA_PATH', raising=False)
    tc = gpu_detect.detect_build_toolchain()
    # cmake and gcc are always missing here; CUDA toolkit detection depends on
    # whether /usr/local/cuda exists on the host, so only assert the toolchain
    # is unusable and the compiler/build tools are reported missing.
    assert tc.available is False
    assert 'cmake' in tc.missing
    assert 'gcc' in tc.missing


# --------------------------------------------------------------------------- #
# llama_server.select_variant / _select_windows_cuda_variant
# --------------------------------------------------------------------------- #


def test_windows_cuda_variant_picks_13_for_cuda_13() -> None:
    gpu = gpu_detect.NvidiaGpuInfo(present=True, gpu_names=('RTX 5090',), driver_version='570', cuda_runtime=(13, 3))
    assert ls._select_windows_cuda_variant(gpu) == 'cuda-13'


def test_windows_cuda_variant_picks_12_for_cuda_12() -> None:
    gpu = gpu_detect.NvidiaGpuInfo(present=True, gpu_names=('RTX 4070',), driver_version='560', cuda_runtime=(12, 4))
    assert ls._select_windows_cuda_variant(gpu) == 'cuda-12'


def test_windows_cuda_variant_none_for_old_cuda() -> None:
    gpu = gpu_detect.NvidiaGpuInfo(present=True, gpu_names=('GTX 1080',), driver_version='470', cuda_runtime=(11, 4))
    assert ls._select_windows_cuda_variant(gpu) is None


def test_windows_cuda_variant_none_when_unknown() -> None:
    gpu = gpu_detect.NvidiaGpuInfo(present=True, gpu_names=('RTX 4070',), driver_version='560', cuda_runtime=None)
    assert ls._select_windows_cuda_variant(gpu) is None


def test_forced_variant_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'cpu')
    assert ls.select_variant() == 'cpu'


def test_forced_variant_cuda_13(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'cuda-13')
    assert ls.select_variant() == 'cuda-13'


def test_forced_variant_invalid_falls_back_to_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'rocm')
    # On the test host (Linux) without NVIDIA detection this resolves to cpu.
    monkeypatch.setattr(gpu_detect, 'detect_nvidia_gpu', lambda: gpu_detect.NvidiaGpuInfo(
        present=False, gpu_names=(), driver_version=None, cuda_runtime=None))
    monkeypatch.setattr(gpu_detect, 'detect_build_toolchain', lambda: gpu_detect.BuildToolchain(
        available=False, cmake_path=None, gcc_path=None, nvcc_path=None, cuda_home=None,
        missing=('cmake', 'gcc', 'CUDA toolkit (nvcc)')))
    assert ls.select_variant() == 'cpu'


def test_select_variant_windows_with_cuda_13(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', '')
    monkeypatch.setattr(ls.sys, 'platform', 'win32')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(gpu_detect, 'detect_nvidia_gpu', lambda: gpu_detect.NvidiaGpuInfo(
        present=True, gpu_names=('RTX 5090',), driver_version='570', cuda_runtime=(13, 3)))
    assert ls.select_variant() == 'cuda-13'


def test_select_variant_windows_nvidia_but_no_cuda_driver_falls_back_to_cpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', '')
    monkeypatch.setattr(ls.sys, 'platform', 'win32')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(gpu_detect, 'detect_nvidia_gpu', lambda: gpu_detect.NvidiaGpuInfo(
        present=True, gpu_names=('RTX 4070',), driver_version='560', cuda_runtime=None))
    assert ls.select_variant() == 'cpu'


def test_select_variant_windows_no_nvidia_is_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', '')
    monkeypatch.setattr(ls.sys, 'platform', 'win32')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(gpu_detect, 'detect_nvidia_gpu', lambda: gpu_detect.NvidiaGpuInfo(
        present=False, gpu_names=(), driver_version=None, cuda_runtime=None))
    assert ls.select_variant() == 'cpu'


def test_select_variant_linux_nvidia_defaults_to_vulkan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', '')
    monkeypatch.setattr(ls.sys, 'platform', 'linux')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(gpu_detect, 'detect_nvidia_gpu', lambda: gpu_detect.NvidiaGpuInfo(
        present=True, gpu_names=('RTX 4070',), driver_version='560', cuda_runtime=(12, 4)))
    # The default path does not probe the build toolchain at all.
    assert ls.select_variant() == 'vulkan'


def test_select_variant_linux_nvidia_no_toolchain_still_vulkan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', '')
    monkeypatch.setattr(ls.sys, 'platform', 'linux')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(gpu_detect, 'detect_nvidia_gpu', lambda: gpu_detect.NvidiaGpuInfo(
        present=True, gpu_names=('RTX 4070',), driver_version='560', cuda_runtime=(12, 4)))
    monkeypatch.setattr(gpu_detect, 'detect_build_toolchain', lambda: gpu_detect.BuildToolchain(
        available=False, cmake_path=None, gcc_path=None, nvcc_path=None, cuda_home=None,
        missing=('cmake', 'gcc', 'CUDA toolkit (nvcc)')))
    assert ls.select_variant() == 'vulkan'


def test_select_variant_linux_no_nvidia_is_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', '')
    monkeypatch.setattr(ls.sys, 'platform', 'linux')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    monkeypatch.setattr(gpu_detect, 'detect_nvidia_gpu', lambda: gpu_detect.NvidiaGpuInfo(
        present=False, gpu_names=(), driver_version=None, cuda_runtime=None))
    assert ls.select_variant() == 'cpu'


def test_forced_variant_compile(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'compile')
    assert ls.select_variant() == 'cuda-compiled'


def test_forced_variant_vulkan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'vulkan')
    assert ls.select_variant() == 'vulkan'


def test_select_variant_macos_is_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', '')
    monkeypatch.setattr(ls.sys, 'platform', 'darwin')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'arm64')
    assert ls.select_variant() == 'cpu'


# --------------------------------------------------------------------------- #
# llama_server.install: cuda-compiled toolchain pre-check
# --------------------------------------------------------------------------- #


def test_install_cuda_compiled_raises_clear_error_when_toolchain_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'compile')
    monkeypatch.setattr(gpu_detect, 'detect_build_toolchain', lambda: gpu_detect.BuildToolchain(
        available=False, cmake_path=None, gcc_path=None, nvcc_path=None, cuda_home=None,
        missing=('cmake', 'gcc', 'CUDA toolkit (nvcc)')))
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: tmp_path / 'llama-server')
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: None)
    monkeypatch.setattr(ls, '_read_variant', lambda: None)
    monkeypatch.setattr(ls, '_install_compiled_cuda', lambda *a, **k: pytest.fail('should not compile'))
    with pytest.raises(RuntimeError, match='CUDA build toolchain'):
        ls.install()


def test_install_cuda_compiled_proceeds_when_toolchain_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'compile')
    monkeypatch.setattr(gpu_detect, 'detect_build_toolchain', lambda: gpu_detect.BuildToolchain(
        available=True, cmake_path='/usr/bin/cmake', gcc_path='/usr/bin/gcc',
        nvcc_path='/usr/local/cuda/bin/nvcc', cuda_home='/usr/local/cuda', missing=()))
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: tmp_path / 'llama-server')
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: None)
    monkeypatch.setattr(ls, '_read_variant', lambda: None)
    calls: list[tuple] = []
    monkeypatch.setattr(ls, '_install_compiled_cuda', lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(ls, 'status', lambda: {'id': 'llama-server', 'state': 'installed'})
    ls.install()
    assert calls and calls[0][1].get('force') is False


# --------------------------------------------------------------------------- #
# llama_server.install: variant override
# --------------------------------------------------------------------------- #


def test_install_variant_override_vulkan(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Env says compile, but explicit variant=vulkan wins.
    monkeypatch.setenv('CLARA_LLAMA_SERVER_CUDA', 'compile')
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: tmp_path / 'llama-server')
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: None)
    monkeypatch.setattr(ls, '_read_variant', lambda: None)
    calls: list[tuple] = []
    monkeypatch.setattr(ls, '_install_prebuilt_vulkan', lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(ls, '_install_prebuilt_cpu', lambda *a, **k: pytest.fail('should not use cpu'))
    monkeypatch.setattr(ls, '_install_compiled_cuda', lambda *a, **k: pytest.fail('should not compile'))
    monkeypatch.setattr(ls, 'status', lambda: {'id': 'llama-server', 'state': 'installed'})
    ls.install(variant='vulkan')
    assert calls and calls[0][1].get('force') is False


def test_install_variant_override_cpu_skips_select(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(ls, 'select_variant', lambda: pytest.fail('should not auto-select'))
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: tmp_path / 'llama-server')
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: None)
    monkeypatch.setattr(ls, '_read_variant', lambda: None)
    calls: list[tuple] = []
    monkeypatch.setattr(ls, '_install_prebuilt_cpu', lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(ls, 'status', lambda: {'id': 'llama-server', 'state': 'installed'})
    ls.install(variant='cpu')
    assert calls


def test_install_variant_auto_selects(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # UI default is the string ``auto``; must auto-select rather than reject.
    monkeypatch.setattr(ls, 'select_variant', lambda: 'cpu')
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: tmp_path / 'llama-server')
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: None)
    monkeypatch.setattr(ls, '_read_variant', lambda: None)
    calls: list[tuple] = []
    monkeypatch.setattr(ls, '_install_prebuilt_cpu', lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(ls, 'status', lambda: {'id': 'llama-server', 'state': 'installed'})
    ls.install(variant='auto')
    assert calls


def test_install_variant_override_invalid_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: tmp_path / 'llama-server')
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: None)
    monkeypatch.setattr(ls, '_read_variant', lambda: None)
    with pytest.raises(RuntimeError, match='Unsupported llama-server variant'):
        ls.install(variant='rocm')


def test_install_variant_override_skips_when_already_installed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    bin_path = tmp_path / 'llama-server'
    bin_path.write_text('#!/bin/sh\n', encoding='utf-8')  # simulate installed binary
    # Thin wrappers also need the co-located impl lib or install() will re-run.
    (tmp_path / 'libllama-server-impl.so').write_bytes(b'impl')
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: bin_path)
    # Simulate the exact variant already installed.
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: 'b10262')
    monkeypatch.setattr(ls, '_read_variant', lambda: 'vulkan')
    monkeypatch.setattr(ls, '_install_prebuilt_vulkan', lambda *a, **k: pytest.fail('should skip'))
    monkeypatch.setattr(ls, 'status', lambda: {'id': 'llama-server', 'state': 'installed'})
    ls.install(variant='vulkan')


def test_install_cuda_12_skips_when_marker_matches_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Marker must store the KEY (``cuda-12``), not the label (``cuda-12.4``).
    monkeypatch.setattr(ls, '_pinned_tag', lambda: 'b10262')
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: tmp_path)
    bin_path = tmp_path / 'llama-server'
    bin_path.write_text('#!/bin/sh\n', encoding='utf-8')
    (tmp_path / 'libllama-server-impl.so').write_bytes(b'impl')
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: bin_path)
    monkeypatch.setattr(ls, 'read_ready_marker', lambda _d: 'b10262')
    monkeypatch.setattr(ls, '_read_variant', lambda: 'cuda-12')
    monkeypatch.setattr(ls, '_install_prebuilt_cuda', lambda *a, **k: pytest.fail('should skip'))
    monkeypatch.setattr(ls, 'status', lambda: {'id': 'llama-server', 'state': 'installed'})
    ls.install(variant='cuda-12')


def test_install_prebuilt_cuda_passes_variant_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_install_prebuilt(tag, variant, **kwargs):
        calls.append(variant)

    monkeypatch.setattr(ls, '_install_prebuilt', fake_install_prebuilt)
    ls._install_prebuilt_cuda('b10262', 'cuda-12', force=False)
    assert calls == ['cuda-12']


# --------------------------------------------------------------------------- #
# llama_server._cpu_asset_name / _CUDA_ASSETS / _version_label
# --------------------------------------------------------------------------- #


def test_cpu_asset_names_per_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ls.sys, 'platform', 'linux')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    assert ls._cpu_asset_name('b10262') == 'llama-b10262-bin-ubuntu-x64.tar.gz'

    monkeypatch.setattr(ls.sys, 'platform', 'darwin')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'arm64')
    assert ls._cpu_asset_name('b10262') == 'llama-b10262-bin-macos-arm64.tar.gz'

    monkeypatch.setattr(ls.sys, 'platform', 'win32')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    assert ls._cpu_asset_name('b10262') == 'llama-b10262-bin-win-cpu-x64.zip'


def test_cuda_assets_table_has_expected_templates() -> None:
    asset12, cudart12, label12 = ls._CUDA_ASSETS['cuda-12']
    assert asset12 == 'llama-{tag}-bin-win-cuda-12.4-x64.zip'
    assert cudart12 == 'cudart-llama-bin-win-cuda-12.4-x64.zip'
    assert label12 == 'cuda-12.4'
    asset13, cudart13, label13 = ls._CUDA_ASSETS['cuda-13']
    assert asset13 == 'llama-{tag}-bin-win-cuda-13.3-x64.zip'
    assert label13 == 'cuda-13.3'


def test_vulkan_asset_names_per_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ls.sys, 'platform', 'linux')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    assert ls._vulkan_asset_name('b10262') == 'llama-b10262-bin-ubuntu-vulkan-x64.tar.gz'

    monkeypatch.setattr(ls.sys, 'platform', 'win32')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'x86_64')
    assert ls._vulkan_asset_name('b10262') == 'llama-b10262-bin-win-vulkan-x64.zip'

    # No Vulkan prebuilt for arm64 Linux or macOS.
    monkeypatch.setattr(ls.sys, 'platform', 'linux')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'aarch64')
    assert ls._vulkan_asset_name('b10262') is None
    monkeypatch.setattr(ls.sys, 'platform', 'darwin')
    monkeypatch.setattr(ls.platform, 'machine', lambda: 'arm64')
    assert ls._vulkan_asset_name('b10262') is None


def test_version_label_includes_variant_for_cuda() -> None:
    assert ls._version_label('b10262', 'cpu') == 'b10262'
    # Marker stores keys; display maps to the precise CUDA asset label.
    assert ls._version_label('b10262', 'cuda-12') == 'b10262 (cuda-12.4)'
    assert ls._version_label('b10262', 'cuda-13') == 'b10262 (cuda-13.3)'
    assert ls._version_label('b10262', 'cuda-compiled') == 'b10262 (cuda-compiled)'
    assert ls._version_label('b10262', 'vulkan') == 'b10262 (vulkan)'


# --------------------------------------------------------------------------- #
# llama_server._copy_cocolocated_libs (shared library co-location)
# --------------------------------------------------------------------------- #


def test_copy_cocolocated_libs_copies_so_dll_and_dylib(tmp_path: Path) -> None:
    """Linux .so (incl. versioned), Windows .dll, and macOS .dylib must all be co-located."""
    src = tmp_path / 'src'
    src.mkdir()
    (src / 'libllama-server-impl.so').write_bytes(b'impl')
    (src / 'libggml.so').write_bytes(b'ggml')
    (src / 'libggml.so.1').write_bytes(b'ggml1')
    (src / 'libggml.so.1.2.3').write_bytes(b'ggml123')
    (src / 'cudart64.dll').write_bytes(b'cudart')
    (src / 'libggml.dylib').write_bytes(b'dylib')
    # Non-library files must be ignored.
    (src / 'README.txt').write_bytes(b'ignore')
    (src / 'llama-server').write_bytes(b'binary')

    dest = tmp_path / 'bin'
    ls._copy_cocolocated_libs(src, dest)

    names = sorted(p.name for p in dest.iterdir())
    assert names == sorted([
        'libllama-server-impl.so',
        'libggml.so',
        'libggml.so.1',
        'libggml.so.1.2.3',
        'cudart64.dll',
        'libggml.dylib',
    ])


def test_copy_cocolocated_libs_also_searches_parent_dir(tmp_path: Path) -> None:
    """ggml-org archives nest the binary in a subdir; some libs sit one level up."""
    root = tmp_path / 'extract'
    nested = root / 'build'
    nested.mkdir(parents=True)
    (nested / 'llama-server').write_bytes(b'binary')
    (root / 'libllama-server-impl.so').write_bytes(b'impl')

    dest = tmp_path / 'bin'
    ls._copy_cocolocated_libs(nested, dest)

    assert (dest / 'libllama-server-impl.so').is_file()
    assert (dest / 'llama-server').exists() is False  # binary not copied by this helper


# --------------------------------------------------------------------------- #
# llama_server._runtime_libs_present (thin-wrapper health check)
# --------------------------------------------------------------------------- #


def test_runtime_libs_present_requires_impl_so_for_thin_linux_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 17 KB thin wrapper without libllama-server-impl.so is not runnable."""
    monkeypatch.setattr(sys, 'platform', 'linux')
    bin_path = tmp_path / 'llama-server'
    bin_path.write_bytes(b'x' * 17_944)
    assert ls._runtime_libs_present(bin_path) is False
    (tmp_path / 'libllama-server-impl.so').write_bytes(b'impl')
    assert ls._runtime_libs_present(bin_path) is True


def test_runtime_libs_present_accepts_fat_binary_without_impl_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, 'platform', 'linux')
    bin_path = tmp_path / 'llama-server'
    bin_path.write_bytes(b'x' * 1_000_001)
    assert ls._runtime_libs_present(bin_path) is True


def test_status_reports_missing_when_thin_binary_lacks_libs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Broken cuda-compiled installs (binary only) must not report installed."""
    monkeypatch.setattr(sys, 'platform', 'linux')
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    bin_path = bin_dir / 'llama-server'
    bin_path.write_bytes(b'x' * 17_944)
    (bin_dir / '.clara-ready').write_text('b10262\n', encoding='utf-8')
    (bin_dir / '.clara-llama-variant').write_text('cuda-compiled\n', encoding='utf-8')
    monkeypatch.setattr(ls, 'llama_server_binary', lambda: bin_path)
    monkeypatch.setattr(ls, 'get_runtime_bin_dir', lambda: bin_dir)
    st = ls.status()
    assert st['state'] == 'missing'
