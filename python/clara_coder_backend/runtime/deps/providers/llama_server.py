"""Install the llama.cpp ``llama-server`` binary into the runtime bin dir.

Asset selection is CUDA/Vulkan-aware:
  * Windows x64 + NVIDIA + CUDA 13.x driver -> prebuilt ``cuda-13.3`` asset + cudart DLLs
  * Windows x64 + NVIDIA + CUDA 12.x driver -> prebuilt ``cuda-12.4`` asset + cudart DLLs
  * Windows x64 + NVIDIA + no/unknown CUDA driver -> CPU fallback
  * Linux x64 + NVIDIA -> prebuilt ``vulkan`` asset (GPU accel via the Vulkan driver
    that ships with the NVIDIA driver; no CUDA toolkit needed)
  * Linux x64 + NVIDIA + ``CLARA_LLAMA_SERVER_CUDA=compile`` -> compile from source
    with ``-DGGML_CUDA=ON`` (requires cmake + gcc + CUDA toolkit; errors clearly if missing)
  * macOS / Linux arm64 / no NVIDIA -> CPU build (existing behavior)

Override the auto choice with ``CLARA_LLAMA_SERVER_CUDA`` (``cpu`` | ``cuda-12`` |
``cuda-13`` | ``vulkan`` | ``compile`` | ``auto``).
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from clara_coder_backend.config import env_clara
from clara_coder_backend.runtime.deps.download import (
    READY_MARKER,
    chmod_executable,
    download_file,
    extract_archive,
    read_ready_marker,
    with_download_lock,
    write_ready_marker,
)
from clara_coder_backend.runtime.deps.paths import (
    get_runtime_bin_dir,
    get_runtime_downloads_dir,
    llama_server_binary,
)
from clara_coder_backend.runtime.deps.progress import PROGRESS
from clara_coder_backend.runtime.deps.providers import gpu_detect

logger = logging.getLogger('clara.runtime.deps.llama_server')

DEP_ID = 'llama-server'
# Pin a known release tag; override with CLARA_LLAMA_SERVER_VERSION (e.g. b10867).
# Need >= b10344 for Nemotron 3.5 Lightning MTP (nextn) GGUF tensors.
# b10867 (2026-09-08): latest ggml-org release; same asset naming as b10375
# (win cuda-12.4 / cuda-13.3 + cudart bundles, win/ubuntu vulkan, cpu builds).
DEFAULT_TAG = 'b10867'
SIZE_HINT = '~40–400 MB (CPU ~40 MB; CUDA build + cudart DLLs up to ~400 MB)'

VARIANT_MARKER = '.clara-llama-variant'
# CUDA build timeout for the Linux compile-from-source path.
COMPILE_TIMEOUT_S = 1800

# Prebuilt CUDA variants shipped by ggml-org for Windows x64.
# (asset template, cudart DLL bundle template, variant label)
_CUDA_ASSETS = {
    'cuda-12': ('llama-{tag}-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip', 'cuda-12.4'),
    'cuda-13': ('llama-{tag}-bin-win-cuda-13.3-x64.zip', 'cudart-llama-bin-win-cuda-13.3-x64.zip', 'cuda-13.3'),
}

# All variants ``install(variant=...)`` may be forced to (internal names).
# ``compile`` (from the env var) maps to ``cuda-compiled``.
_VALID_VARIANTS = ('cpu', 'cuda-12', 'cuda-13', 'vulkan', 'cuda-compiled')


def _pinned_tag() -> str:
    return env_clara('CLARA_LLAMA_SERVER_VERSION', DEFAULT_TAG).strip() or DEFAULT_TAG


def _forced_variant() -> str | None:
    """Return a forced variant from ``CLARA_LLAMA_SERVER_CUDA`` or ``None`` for auto.

    ``compile`` maps to the internal ``cuda-compiled`` variant.
    """
    raw = env_clara('CLARA_LLAMA_SERVER_CUDA', '').strip().lower()
    if not raw or raw == 'auto':
        return None
    mapping = {
        'cpu': 'cpu',
        'cuda-12': 'cuda-12',
        'cuda-13': 'cuda-13',
        'vulkan': 'vulkan',
        'compile': 'cuda-compiled',
    }
    if raw in mapping:
        return mapping[raw]
    logger.warning(
        'ignoring unsupported CLARA_LLAMA_SERVER_CUDA=%r (expected cpu|cuda-12|cuda-13|vulkan|compile|auto)',
        raw,
    )
    return None


def _cpu_asset_name(tag: str) -> str:
    system = sys.platform
    machine = platform.machine().lower()
    if system.startswith('linux'):
        if machine in ('aarch64', 'arm64'):
            return f'llama-{tag}-bin-ubuntu-arm64.tar.gz'
        return f'llama-{tag}-bin-ubuntu-x64.tar.gz'
    if system == 'darwin':
        if machine in ('aarch64', 'arm64'):
            return f'llama-{tag}-bin-macos-arm64.tar.gz'
        return f'llama-{tag}-bin-macos-x64.tar.gz'
    if system.startswith('win'):
        if machine in ('aarch64', 'arm64'):
            return f'llama-{tag}-bin-win-cpu-arm64.zip'
        return f'llama-{tag}-bin-win-cpu-x64.zip'
    raise RuntimeError(f'Unsupported platform for llama-server: {system}/{machine}')


def _vulkan_asset_name(tag: str) -> str | None:
    """Return the ggml-org Vulkan prebuilt asset name for this host, or ``None``.

    Vulkan prebuilts exist for Linux x64 and Windows x64 (not arm64, not macOS).
    """
    system = sys.platform
    machine = platform.machine().lower()
    if system.startswith('linux') and machine not in ('aarch64', 'arm64'):
        return f'llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz'
    if system.startswith('win') and machine not in ('aarch64', 'arm64'):
        return f'llama-{tag}-bin-win-vulkan-x64.zip'
    return None


def _select_windows_cuda_variant(gpu: gpu_detect.NvidiaGpuInfo) -> str | None:
    """Pick ``cuda-12`` or ``cuda-13`` for Windows based on the CUDA driver version."""
    major = gpu.cuda_major
    if major is None:
        return None
    if major >= 13:
        return 'cuda-13'
    if major >= 12:
        return 'cuda-12'
    return None


def select_variant() -> str:
    """Resolve the variant this host should install.

    Returns ``cpu``, ``cuda-12``, ``cuda-13``, ``vulkan``, or ``cuda-compiled``
    (Linux source build, opt-in only).
    """
    forced = _forced_variant()
    if forced is not None:
        return forced

    system = sys.platform
    machine = platform.machine().lower()
    if system.startswith('win') and machine not in ('aarch64', 'arm64'):
        gpu = gpu_detect.detect_nvidia_gpu()
        if gpu.present:
            cuda_variant = _select_windows_cuda_variant(gpu)
            if cuda_variant:
                return cuda_variant
            logger.info('NVIDIA GPU detected but CUDA driver version unknown; falling back to CPU')
        return 'cpu'

    if system.startswith('linux') and machine not in ('aarch64', 'arm64'):
        gpu = gpu_detect.detect_nvidia_gpu()
        if gpu.present:
            # Vulkan prebuilt gives GPU accel via the NVIDIA Vulkan driver without
            # requiring the CUDA toolkit. Compile-from-source is opt-in via env.
            return 'vulkan'
        return 'cpu'

    return 'cpu'


def _variant_marker_path() -> Path:
    return get_runtime_bin_dir() / VARIANT_MARKER


def _read_variant() -> str | None:
    marker = _variant_marker_path()
    if not marker.is_file():
        return None
    text = marker.read_text(encoding='utf-8').strip()
    return text or None


def _write_variant(variant: str) -> None:
    _variant_marker_path().write_text(variant + '\n', encoding='utf-8')


def components() -> list[str]:
    """What the install drops into ``runtime/bin`` (reflects the installed variant when known)."""

    variant = _read_variant()
    out = ['llama-server', 'ggml / llama shared libs']
    if variant in ('cuda-12', 'cuda-13'):
        out.append('cudart DLLs')
    if variant:
        out.append(f'variant: {variant}')
    return out


def _find_binary_in_tree(root: Path) -> Path | None:
    names = ('llama-server.exe', 'llama-server')
    for name in names:
        direct = root / name
        if direct.is_file():
            return direct
    for name in names:
        matches = list(root.rglob(name))
        if matches:
            return matches[0]
    return None


def _version_label(tag: str, variant: str) -> str:
    if variant == 'cpu':
        return tag
    # Marker stores the variant KEY; map CUDA keys to the precise label for display.
    display = _CUDA_ASSETS[variant][2] if variant in _CUDA_ASSETS else variant
    return f'{tag} ({display})'


def _runtime_libs_present(bin_path: Path) -> bool:
    """Return True when the installed binary can resolve its co-located shared libs.

    Recent llama.cpp builds ship a thin ``llama-server`` that ``dlopen``s
    ``libllama-server-impl`` from the same directory (``$ORIGIN``). A binary
    without those libs is not runnable — treat it as not installed so
    ``install()`` will repair instead of no-op.
    """
    if not bin_path.is_file():
        return False
    if sys.platform.startswith('win'):
        # Windows resolves same-dir DLLs via the standard DLL search order.
        return True
    bin_dir = bin_path.parent
    for name in ('libllama-server-impl.so', 'libllama-server-impl.dylib'):
        if (bin_dir / name).is_file():
            return True
    # Older fat binaries may embed the server without a separate impl lib.
    try:
        return bin_path.stat().st_size > 1_000_000
    except OSError:
        return False


def status() -> dict:
    bin_path = llama_server_binary()
    marker_dir = get_runtime_bin_dir()
    version = read_ready_marker(marker_dir)
    variant = _read_variant()
    # Binary + co-located libs (when required) are enough for Electron spawn;
    # marker supplies version when present.
    if _runtime_libs_present(bin_path):
        label = _version_label(version or 'installed', variant or 'cpu')
        return {
            'id': DEP_ID,
            'label': 'llama-server',
            'description': 'llama.cpp server binary for managed local models.',
            'version': label,
            'state': 'installed',
            'path': str(bin_path),
            'sizeHint': SIZE_HINT,
            'canDelete': True,
            'error': None,
        }
    return {
        'id': DEP_ID,
        'label': 'llama-server',
        'description': 'llama.cpp server binary for managed local models.',
        'version': None,
        'state': 'missing',
        'path': None,
        'sizeHint': SIZE_HINT,
        'canDelete': True,
        'error': None,
    }


def _install_prebuilt_cpu(tag: str, *, force: bool) -> None:
    asset = _cpu_asset_name(tag)
    url = f'https://github.com/ggml-org/llama.cpp/releases/download/{tag}/{asset}'
    _install_prebuilt(tag, 'cpu', asset=asset, url=url, force=force, extra_assets=())


def _install_prebuilt_vulkan(tag: str, *, force: bool) -> None:
    asset = _vulkan_asset_name(tag)
    if not asset:
        raise RuntimeError('No Vulkan prebuilt asset is available for this platform')
    url = f'https://github.com/ggml-org/llama.cpp/releases/download/{tag}/{asset}'
    _install_prebuilt(tag, 'vulkan', asset=asset, url=url, force=force, extra_assets=())


def _install_prebuilt_cuda(tag: str, variant_key: str, *, force: bool) -> None:
    asset_tmpl, cudart_tmpl, _label = _CUDA_ASSETS[variant_key]
    asset = asset_tmpl.format(tag=tag)
    cudart_asset = cudart_tmpl.format(tag=tag)
    base = f'https://github.com/ggml-org/llama.cpp/releases/download/{tag}'
    # Store the variant KEY in the marker so install() idempotency matches ``chosen``.
    _install_prebuilt(
        tag,
        variant_key,
        asset=asset,
        url=f'{base}/{asset}',
        force=force,
        extra_assets=((cudart_asset, f'{base}/{cudart_asset}'),),
    )


def _install_prebuilt(
    tag: str,
    variant: str,
    *,
    asset: str,
    url: str,
    force: bool,
    extra_assets: tuple[tuple[str, str], ...],
) -> None:
    bin_dir = get_runtime_bin_dir()
    bin_path = llama_server_binary()
    downloads = get_runtime_downloads_dir()
    archive = downloads / asset
    extract_dir = downloads / f'llama-extract-{tag}-{variant}'
    lock = downloads / f'.llama-{tag}-{variant}.lock'

    def _ready() -> bool:
        return (
            _runtime_libs_present(bin_path)
            and read_ready_marker(bin_dir) == tag
            and _read_variant() == variant
        )

    with with_download_lock(lock, ready_check=_ready) as lock_ctx:
        if not lock_ctx.held and _ready():
            return
        if force and bin_path.exists():
            bin_path.unlink(missing_ok=True)
        (bin_dir / READY_MARKER).unlink(missing_ok=True)
        _variant_marker_path().unlink(missing_ok=True)

        PROGRESS.emit(DEP_ID, 'downloading', message=f'Downloading {asset}…')

        def _prog(done: int, total: int | None) -> None:
            PROGRESS.emit(
                DEP_ID,
                'downloading',
                bytes_done=done,
                bytes_total=total,
                message=f'Downloading {asset}…',
            )

        download_file(url, archive, on_progress=_prog, timeout=300)

        # CUDA builds need the matching cudart DLL bundle extracted next to the binary.
        for extra_name, extra_url in extra_assets:
            extra_archive = downloads / extra_name
            PROGRESS.emit(DEP_ID, 'downloading', message=f'Downloading {extra_name}…')

            def _extra_prog(done: int, total: int | None, _name=extra_name) -> None:
                PROGRESS.emit(
                    DEP_ID,
                    'downloading',
                    bytes_done=done,
                    bytes_total=total,
                    message=f'Downloading {_name}…',
                )

            download_file(extra_url, extra_archive, on_progress=_extra_prog, timeout=600)
            PROGRESS.emit(DEP_ID, 'extracting', message=f'Extracting {extra_name}…')
            extra_extract = downloads / f'llama-extract-{tag}-{variant}-cudart'
            extract_archive(extra_archive, extra_extract)
            _copy_cocolocated_libs(extra_extract, bin_dir)
            shutil.rmtree(extra_extract, ignore_errors=True)

        PROGRESS.emit(DEP_ID, 'extracting', message='Extracting archive…')
        extract_archive(archive, extract_dir)
        found = _find_binary_in_tree(extract_dir)
        if not found:
            logger.error('llama-server binary missing from archive %s', asset)
            raise RuntimeError(f'llama-server binary not found in {asset}')
        bin_dir.mkdir(parents=True, exist_ok=True)
        if bin_path.exists():
            bin_path.unlink()
        shutil.copy2(found, bin_path)
        chmod_executable(bin_path)
        # Co-locate any shared libraries shipped alongside the binary (DLLs on
        # Windows, libllama-server-impl.so / libggml*.so on Linux, dylibs on macOS).
        _copy_cocolocated_libs(found.parent, bin_dir)
        write_ready_marker(bin_dir, tag)
        _write_variant(variant)
        shutil.rmtree(extract_dir, ignore_errors=True)


def _copy_cocolocated_libs(src_dir: Path, dest_dir: Path) -> None:
    """Copy shared libraries shipped alongside the binary into ``dest_dir``.

    ggml-org archives nest the binary under a subdirectory and place its shared
    libraries next to it: ``*.dll`` on Windows, ``*.so*`` on Linux
    (``libllama-server-impl.so``, ``libggml*.so``, versioned ``*.so.1.2.3``),
    and ``*.dylib*`` on macOS. The binary's RUNPATH is ``$ORIGIN``, so these
    must sit in the same directory as ``llama-server`` to load at runtime.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    for candidate in (src_dir, src_dir.parent):
        if not candidate.is_dir():
            continue
        for pattern in ('*.dll', '*.so*', '*.dylib*'):
            for lib in candidate.glob(pattern):
                if lib.name in seen:
                    continue
                seen.add(lib.name)
                shutil.copy2(lib, dest_dir / lib.name)
                logger.info('co-located lib %s', lib.name)


def _ensure_origin_runpath(bin_dir: Path) -> None:
    """Rewrite ELF RUNPATH to ``$ORIGIN`` when ``patchelf`` is available.

    CMake source builds often bake an absolute build-dir RUNPATH. After we
    co-locate libs next to ``llama-server`` and delete the build tree, that
    absolute path is dead. Prebuilt ggml-org assets already use ``$ORIGIN``.
    """
    if not sys.platform.startswith('linux'):
        return
    patchelf = shutil.which('patchelf')
    if not patchelf:
        logger.info('patchelf not found; relying on CMAKE_BUILD_RPATH_USE_ORIGIN / LD_LIBRARY_PATH')
        return
    targets = [p for p in bin_dir.iterdir() if p.is_file() and (p.name == 'llama-server' or '.so' in p.name)]
    for target in targets:
        try:
            subprocess.run(
                [patchelf, '--set-rpath', '$ORIGIN', str(target)],
                check=True,
                capture_output=True,
                text=True,
            )
            logger.info('set RUNPATH=$ORIGIN on %s', target.name)
        except (OSError, subprocess.CalledProcessError) as exc:
            logger.warning('patchelf failed for %s: %s', target.name, exc)


def _install_compiled_cuda(tag: str, *, force: bool) -> None:
    """Download the llama.cpp source for ``tag`` and build ``llama-server`` with CUDA."""
    bin_dir = get_runtime_bin_dir()
    bin_path = llama_server_binary()
    downloads = get_runtime_downloads_dir()
    src_archive = downloads / f'llama-src-{tag}.tar.gz'
    src_url = f'https://github.com/ggml-org/llama.cpp/archive/refs/tags/{tag}.tar.gz'
    src_root = downloads / f'llama-src-{tag}'
    build_dir = src_root / 'build'
    lock = downloads / f'.llama-{tag}-cuda-compiled.lock'

    def _ready() -> bool:
        return (
            _runtime_libs_present(bin_path)
            and read_ready_marker(bin_dir) == tag
            and _read_variant() == 'cuda-compiled'
        )

    # Compile can take up to COMPILE_TIMEOUT_S; wait at least that long for a live holder.
    with with_download_lock(lock, ready_check=_ready, wait_s=float(COMPILE_TIMEOUT_S + 120)) as lock_ctx:
        if not lock_ctx.held and _ready():
            return
        if force and bin_path.exists():
            bin_path.unlink(missing_ok=True)
        (bin_dir / READY_MARKER).unlink(missing_ok=True)
        _variant_marker_path().unlink(missing_ok=True)

        PROGRESS.emit(DEP_ID, 'downloading', message=f'Downloading llama.cpp source {tag}…')

        def _prog(done: int, total: int | None) -> None:
            PROGRESS.emit(
                DEP_ID,
                'downloading',
                bytes_done=done,
                bytes_total=total,
                message=f'Downloading llama.cpp source {tag}…',
            )

        download_file(src_url, src_archive, on_progress=_prog, timeout=300)
        PROGRESS.emit(DEP_ID, 'extracting', message='Extracting source…')
        extract_archive(src_archive, src_root)

        # The tarball extracts to a single top-level dir like ``llama.cpp-b10867``.
        nested = list(src_root.iterdir())
        actual_root = nested[0] if len(nested) == 1 and nested[0].is_dir() else src_root

        toolchain = gpu_detect.detect_build_toolchain()
        cmake = toolchain.cmake_path or 'cmake'
        env = os.environ.copy()
        if toolchain.cuda_home:
            env.setdefault('CUDA_HOME', toolchain.cuda_home)
            env.setdefault('CUDA_PATH', toolchain.cuda_home)
        # cmake's enable_language(CUDA) locates the compiler via CUDACXX, not CUDA_HOME.
        # Point it at nvcc explicitly (it is often not on PATH on Linux).
        if toolchain.nvcc_path:
            env.setdefault('CUDACXX', toolchain.nvcc_path)

        PROGRESS.emit(DEP_ID, 'installing', message='Configuring CMake (GGML_CUDA=ON)…')
        # Bake $ORIGIN into RUNPATH so the thin llama-server wrapper finds
        # libllama-server-impl.so next to itself after we delete the build tree.
        # CMAKE_BUILD_RPATH_USE_ORIGIN rewrites absolute build paths to $ORIGIN;
        # BUILD_WITH_INSTALL_RPATH keeps that on the linked binary (no install step).
        configure_cmd = [
            cmake, '-S', str(actual_root), '-B', str(build_dir),
            '-DGGML_CUDA=ON', '-DCMAKE_BUILD_TYPE=Release',
            '-DLLAMA_CURL=OFF', '-DLLAMA_BUILD_TESTS=OFF',
            '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_SERVER=ON',
            '-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON',
            '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
            '-DCMAKE_INSTALL_RPATH=$ORIGIN',
        ]
        _run_compile_step(configure_cmd, phase='CMake configure', timeout=600, env=env)

        PROGRESS.emit(DEP_ID, 'installing', message='Compiling llama-server with CUDA (this can take 10–30 min)…')
        build_cmd = [cmake, '--build', str(build_dir), '--config', 'Release', '--target', 'llama-server', '-j']
        _run_compile_step(build_cmd, phase='CMake build', timeout=COMPILE_TIMEOUT_S, env=env)

        found = _find_binary_in_tree(build_dir)
        if not found:
            logger.error('compiled llama-server binary not found under %s', build_dir)
            raise RuntimeError('Compiled llama-server binary not found in build output')
        bin_dir.mkdir(parents=True, exist_ok=True)
        if bin_path.exists():
            bin_path.unlink()
        shutil.copy2(found, bin_path)
        chmod_executable(bin_path)
        # Must co-locate shared libs before deleting the build tree — the binary's
        # RUNPATH otherwise points at a removed directory (exit 127 at launch).
        _copy_cocolocated_libs(found.parent, bin_dir)
        _ensure_origin_runpath(bin_dir)
        if not _runtime_libs_present(bin_path):
            raise RuntimeError(
                'Compiled llama-server is missing co-located shared libraries '
                '(e.g. libllama-server-impl.so) in the runtime bin directory'
            )
        write_ready_marker(bin_dir, tag)
        _write_variant('cuda-compiled')
        shutil.rmtree(src_root, ignore_errors=True)


def _run_compile_step(cmd: list[str], *, phase: str, timeout: int, env: dict[str, str] | None = None) -> None:
    """Run a build step, streaming stdout/stderr lines to the progress bus.

    Each output line is emitted as an ``installing`` progress event with the line
    as the message, so the Dependencies window terminal shows live cmake output.
    """
    logger.info('%s: %s', phase, ' '.join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
    except (FileNotFoundError, OSError) as exc:
        raise RuntimeError(f'{phase} failed: {exc}') from exc

    assert proc.stdout is not None
    collected: list[str] = []
    for line in proc.stdout:
        stripped = line.rstrip('\r\n')
        if stripped:
            collected.append(stripped)
            PROGRESS.emit(DEP_ID, 'installing', message=stripped)
    proc.stdout.close()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f'{phase} timed out after {timeout}s')
    if proc.returncode != 0:
        tail = '\n'.join(collected[-40:])
        raise RuntimeError(f'{phase} failed with exit code {proc.returncode}\n{tail}')


def install(*, force: bool = False, variant: str | None = None) -> dict:
    tag = _pinned_tag()
    # UI default is the string ``auto``; treat it like ``None`` (auto-detect).
    if variant is None or variant == 'auto':
        chosen = select_variant()
    elif variant not in _VALID_VARIANTS:
        raise RuntimeError(
            f'Unsupported llama-server variant {variant!r}; expected one of {_VALID_VARIANTS}'
        )
    else:
        chosen = variant
    logger.info('install llama-server tag=%s variant=%s force=%s', tag, chosen, force)
    bin_dir = get_runtime_bin_dir()
    bin_path = llama_server_binary()

    if (
        not force
        and _runtime_libs_present(bin_path)
        and read_ready_marker(bin_dir) == tag
        and _read_variant() == chosen
    ):
        logger.info('llama-server already installed path=%s variant=%s', bin_path, chosen)
        PROGRESS.emit(DEP_ID, 'done', message='Already installed')
        return status()

    if chosen == 'cuda-compiled':
        toolchain = gpu_detect.detect_build_toolchain()
        if not toolchain.available:
            missing = ', '.join(toolchain.missing) or 'unknown toolchain components'
            raise RuntimeError(
                'compile variant requires the CUDA build toolchain. '
                f'Missing: {missing}. Install cmake, gcc, and the NVIDIA CUDA toolkit, '
                'or choose a different variant (auto/vulkan/cpu).'
            )
        _install_compiled_cuda(tag, force=force)
    elif chosen in _CUDA_ASSETS:
        _install_prebuilt_cuda(tag, chosen, force=force)
    elif chosen == 'vulkan':
        _install_prebuilt_vulkan(tag, force=force)
    else:
        _install_prebuilt_cpu(tag, force=force)

    logger.info('llama-server ready path=%s variant=%s', bin_path, chosen)
    PROGRESS.emit(DEP_ID, 'done', message=f'llama-server ready ({chosen})')
    return status()


def delete() -> dict:
    bin_dir = get_runtime_bin_dir()
    bin_path = llama_server_binary()
    logger.info('delete llama-server path=%s', bin_path)
    if bin_path.exists():
        bin_path.unlink(missing_ok=True)
    (bin_dir / READY_MARKER).unlink(missing_ok=True)
    _variant_marker_path().unlink(missing_ok=True)
    # Remove co-located shared libraries (DLLs on Windows, .so on Linux, dylibs on macOS).
    for pattern in ('*.dll', '*.so*', '*.dylib*'):
        for lib in bin_dir.glob(pattern):
            try:
                lib.unlink()
            except OSError:
                pass
    PROGRESS.emit(DEP_ID, 'done', message='llama-server removed')
    return status()
