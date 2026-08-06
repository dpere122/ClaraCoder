"""NVIDIA GPU and CUDA runtime detection for the llama-server provider.

Used to decide between prebuilt CUDA binaries (Windows), compiling from source
(Linux), and the CPU fallback. Detection is best-effort: any failure returns
``None`` so callers can fall back to the CPU build.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger('clara.runtime.deps.gpu_detect')

# CUDA driver API version -> (major, minor). cuDriverGetVersion returns
# ``major * 1000 + minor * 10`` (e.g. 12.4 -> 12040, 13.3 -> 13030).
_CUDA_VERSION_RE = re.compile(r'CUDA Version:\s*(\d+)\.(\d+)')


@dataclass(frozen=True)
class NvidiaGpuInfo:
    """Detected NVIDIA driver / GPU state. ``None`` fields mean "unknown"."""

    present: bool
    gpu_names: tuple[str, ...]
    driver_version: str | None
    cuda_runtime: tuple[int, int] | None  # (major, minor) of CUDA driver API

    @property
    def cuda_major(self) -> int | None:
        return self.cuda_runtime[0] if self.cuda_runtime else None


@dataclass(frozen=True)
class BuildToolchain:
    """Whether the local toolchain can compile llama.cpp with CUDA on Linux."""

    available: bool
    cmake_path: str | None
    gcc_path: str | None
    nvcc_path: str | None
    cuda_home: str | None
    missing: tuple[str, ...]


def _run(cmd: list[str], *, timeout: float = 15.0) -> tuple[int, str, str]:
    """Run a command, swallowing OS errors. Returns (returncode, stdout, stderr)."""

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout or '', proc.stderr or ''
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return -1, '', ''


def _cu_driver_get_version() -> tuple[int, int] | None:
    """Call ``cuDriverGetVersion`` via the NVIDIA driver library.

    Works on Windows (``nvcuda.dll``) and Linux (``libcuda.so.1``). Returns the
    max CUDA runtime version the installed driver supports, or ``None``.
    """

    if sys.platform.startswith('win'):
        lib_name = 'nvcuda.dll'
    else:
        lib_name = 'libcuda.so.1'

    try:
        import ctypes
    except ImportError:  # pragma: no cover - ctypes always present in CPython
        return None

    try:
        if sys.platform.startswith('win'):
            nvcuda = ctypes.WinDLL(lib_name)
        else:
            nvcuda = ctypes.CDLL(lib_name)
    except OSError:
        return None

    try:
        version = ctypes.c_int(0)
        nvcuda.cuDriverGetVersion(ctypes.byref(version))
        raw = int(version.value)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug('cuDriverGetVersion failed: %s', exc)
        return None

    if raw <= 0:
        return None
    major = raw // 1000
    minor = (raw % 1000) // 10
    return (major, minor)


def _nvidia_smi_gpu_names() -> tuple[tuple[str, ...], str | None]:
    """Use ``nvidia-smi`` to list GPU names and the driver version."""

    rc, out, _ = _run(['nvidia-smi', '--query-gpu=name,driver_version', '--format=csv,noheader,nounits'])
    if rc != 0 or not out.strip():
        return (), None
    names: list[str] = []
    driver_version: str | None = None
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(',')]
        if len(parts) >= 2:
            names.append(parts[0])
            if driver_version is None:
                driver_version = parts[1]
    return tuple(names), driver_version


def detect_nvidia_gpu() -> NvidiaGpuInfo:
    """Detect an NVIDIA GPU and the CUDA driver-API version it supports.

    Returns an :class:`NvidiaGpuInfo` with ``present=False`` if nothing is found.
    """

    names, driver_version = _nvidia_smi_gpu_names()
    present = bool(names)
    cuda_runtime = _cu_driver_get_version() if present else None

    if present and cuda_runtime is None and driver_version:
        # Last-resort: parse "CUDA Version: X.Y" from the default nvidia-smi table.
        rc, out, _ = _run(['nvidia-smi'], timeout=15.0)
        if rc == 0:
            match = _CUDA_VERSION_RE.search(out)
            # The first X.Y in nvidia-smi output is the CUDA version in the header.
            if match:
                cuda_runtime = (int(match.group(1)), int(match.group(2)))

    return NvidiaGpuInfo(
        present=present,
        gpu_names=names,
        driver_version=driver_version,
        cuda_runtime=cuda_runtime,
    )


def detect_build_toolchain() -> BuildToolchain:
    """Check whether the local toolchain can build llama.cpp with CUDA on Linux.

    Looks for ``cmake``, a C/C++ compiler (``gcc``/``g++``), and the CUDA toolkit
    (``nvcc`` / ``CUDA_HOME`` / ``/usr/local/cuda``).
    """

    missing: list[str] = []
    cmake = shutil.which('cmake')
    gcc = shutil.which('gcc') or shutil.which('cc')
    nvcc = shutil.which('nvcc')

    cuda_home = os.environ.get('CUDA_HOME') or os.environ.get('CUDA_PATH')
    if not cuda_home and nvcc:
        cuda_home = str(Path(nvcc).resolve().parent.parent)
    if not cuda_home:
        default_cuda = Path('/usr/local/cuda')
        if default_cuda.is_dir():
            cuda_home = str(default_cuda)

    # nvcc may be installed but not on PATH; resolve it from cuda_home so cmake
    # can be pointed at it via CUDACXX.
    if not nvcc and cuda_home:
        candidate = Path(cuda_home) / 'bin' / 'nvcc'
        if candidate.is_file():
            nvcc = str(candidate)

    if not cmake:
        missing.append('cmake')
    if not gcc:
        missing.append('gcc')
    if not nvcc:
        missing.append('CUDA toolkit (nvcc)')

    available = not missing
    return BuildToolchain(
        available=available,
        cmake_path=cmake,
        gcc_path=gcc,
        nvcc_path=nvcc,
        cuda_home=cuda_home,
        missing=tuple(missing),
    )
