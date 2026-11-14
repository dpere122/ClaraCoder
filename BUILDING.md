# Building Clara Coder

Clara Coder is an Electron app with an Angular UI and a Python (FastAPI + LangGraph) backend. For Python API details, env vars and layout, see [python/README.md](python/README.md). For how agent tools are written, see [python/TOOLS.md](python/TOOLS.md).

A fresh clone takes roughly 5–15 minutes to set up, depending on network speed (PyTorch and Kokoro are the slow parts).

### Prerequisites

| Tool                 | Notes |
| -------------------- | ----- |
| **Node.js 22.12+ + npm** | Required for Electron, Angular, and native addon rebuilds (Electron 45 and `better-sqlite3` 13 need Node 22.12 or newer; CI uses Node 24). The repo pins `npm@11.9.0`; any recent npm 11.x is fine. |
| **Python 3.10–3.13** | One system Python is enough. `npm run setup:python` creates the repo-root `.venv` for you — you do **not** need a separate 3.12 install. |
| **Git**              | Needed when Kokoro cannot install from PyPI (today: Python 3.13+); `setup:python` falls back to GitHub for misaki/kokoro. |
| **Build toolchain**  | Needed to compile `node-pty`: on Linux a compiler + Python headers (`build-essential`, `python3-venv`, etc.), on Windows Visual Studio Build Tools; see [node-pty / Spectre note](#native-modules-better-sqlite3--node-pty) below. Windows and macOS can do without it: `node-pty` ships prebuilt binaries for them, and `npm install` uses those without compiling. `better-sqlite3` is never compiled. |

Optional:

- **espeak-ng** — improves Kokoro English fallback for out-of-vocabulary words ([Kokoro docs](https://pypi.org/project/kokoro/)).
- **An LLM connection** — a Claude, OpenAI or OpenRouter API key, a running LM Studio, or a GGUF model for the managed `llama-server`. All are configured in the app after launch, not at build time.

### 1. Clone and install Node dependencies

```bash
git clone https://github.com/dpere122/ClaraCoder.git
cd ClaraCoder
npm install
```

One root `package.json` covers Electron and the Angular UI. `postinstall`, `npm run dev`, `npm start`, and `npm run pack` check that the pinned Electron loads the native modules (`node-pty`, `better-sqlite3`) and rebuild one only if it does not: no binary for the platform, or one compiled for a different Node/Electron ABI (for example after copying `node_modules` between machines). Prefer `npm install` on each device rather than copying `node_modules` across OS or CPU architectures.

If you previously had a separate `src/renderer/node_modules` (or an old workspace install), clean once and reinstall:

```bash
rm -rf node_modules src/renderer/node_modules
npm install
```

### 2. Install Python dependencies (including Kokoro TTS)

```bash
npm run setup:python
```

This creates the repo-root `.venv/` if missing, then installs PyTorch, `python/requirements.txt`, and Kokoro. In dev, the app auto-detects that interpreter.

Use `setup:python` when you have an NVIDIA GPU (installs CUDA PyTorch `cu129`, required for RTX 50-series / Blackwell). Use `npm run setup:python:cpu` on machines without CUDA.

Kokoro is installed via PyPI when possible; if PyPI cannot satisfy your Python (today: 3.13+), the script falls back to GitHub. Do **not** rely on `pip install -r python/requirements.txt` alone.

On Debian/Ubuntu, if venv creation fails, install `python3-venv` (or `python3.XX-venv`) first.

Override the base interpreter used to create `.venv` if needed:

```bash
PYTHON=/path/to/python3 npm run setup:python:cpu
```

### 3. Run the app

```bash
npm run dev
```

This starts:

- Angular dev server at `http://127.0.0.1:4200`
- TypeScript watch build for the Electron main process
- Electron with hot reload (`electronmon`)

Use the **Electron window** for the full app. Do not use `npm run start` for development — that expects a pre-built UI under `dist/renderer/`.

Stop dev with **Ctrl+C** in the terminal running `npm run dev`.

### 4. Verify the setup (optional)

**Python / Kokoro**

```bash
.venv/bin/python -c "from kokoro import KPipeline; print('Kokoro OK')"
```

On Windows, use `.venv\Scripts\python` in place of `.venv/bin/python` here and below.

**GPU PyTorch (NVIDIA)**

```bash
.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')"
```

Expect a `+cu129` version, `True`, and your GPU name. RTX 50-series (Blackwell) needs `cu129`; if you see a CPU build (`+cpu`) or sm_120 warnings, re-run `npm run setup:python` (not `setup:python:cpu`).

**Tests**

```bash
npm test            # renderer (Angular + Vitest)
npm run test:node   # Electron main / preload / shared / scripts
```

Backend tests need the dev requirements (`pip install -r python/requirements-dev.txt -c python/requirements.lock`), then run `python -m pytest -q` from `python/`.

The CI workflow (`.github/workflows/ci.yml`) runs all three suites, the theme registry check, and the type-check and production build on every pull request and every push to `master`.

### Packaging

```bash
npm run pack:dir
```

`pack` / `pack:dir` run three bundling steps first: `bundle:python` (downloads a portable CPython into `runtime-bundle/python/`, installs `python/requirements.txt` into that interpreter, and writes `.clara-runtime-manifest.json`), `bundle:vtsls` (the TypeScript/JavaScript language server), and `bundle:rg` (a pinned ripgrep for workspace search). They then compile and invoke electron-builder. After a successful pack, `scripts/verify-packed-runtime.mjs` checks the unpacked resources (interpreter, manifest, backend sources, vtsls). Packaged output lands under `release/` (or `release-pack-<timestamp>/` if the folder is locked on Windows).

In packaged builds only the bundled runtime is used. `CLARA_PYTHON`, the repo-root `.venv`, and system Python apply to development only.

To regenerate `python/requirements.lock` from the bundled interpreter:

```bash
npm run bundle:python -- --force --write-lock
```

On **Linux**, `npm run pack` builds a `.deb` and an AppImage. Prefer the `.deb` on Debian/Ubuntu. The AppImage needs FUSE 2 (`libfuse.so.2`); on Debian 13 / Ubuntu 24.04+ install `libfuse2t64` first, or run with `APPIMAGE_EXTRACT_AND_RUN=1`.

<details>
<summary><b>Agent PATH on packaged launches</b></summary>

Desktop launchers give the app a stripped GUI `PATH`, so agent `run_command` cannot find CLIs that work in a login terminal (`gh`, `cargo`, `~/.local/bin`, nvm/fnm/asdf shims, Homebrew, …). The workspace terminal is unaffected — it is an interactive shell that sources your profile.

Clara Coder reconstructs user bins once at startup (login-shell `PATH` probe + well-known directories that exist) and applies that to the sidecar that agent commands inherit. Add extra directories in **Settings → Tools → Extra PATH directories** (one per line). The login probe reads `PATH` only; it does not copy API keys or other profile secrets into agent env.

</details>

<details>
<summary><b>Dependencies window</b></summary>

After install (or in dev), open **Dependencies** to download optional runtime pieces into app data (`runtime/`):

| Dependency | Purpose |
| ---------- | ------- |
| llama-server | Managed local llama.cpp binary (no system install required) |
| Java LSP (JDT LS) | Eclipse JDT Language Server for Java |
| Rust LSP (rust-analyzer) | rust-analyzer for Rust; needs a Rust toolchain (cargo) and runs only in a trusted workspace |
| Kokoro TTS | Local neural TTS (CPU PyTorch + kokoro) |
| Whisper STT | Local speech-to-text (faster-whisper, CPU CTranslate2) |

Heavy pieces are on-demand; the packaged app ships a portable Python with core backend packages plus the backend sources. Kokoro and Whisper install into an app-data venv layered on that Python (`runtime/python-venv`), which their installs create when needed.

</details>

<details>
<summary><b>llama-server GPU acceleration (auto-detected)</b></summary>

The `llama-server` installer probes the host and picks a GPU-accelerated build when one is available, falling back to CPU otherwise:

| Host | Build selected |
| ---- | -------------- |
| Windows x64 + NVIDIA + CUDA 13.x driver | Prebuilt CUDA 13.5 binary (+ bundled cudart DLLs) |
| Windows x64 + NVIDIA + CUDA 12.x driver | Prebuilt CUDA 12.4 binary (+ bundled cudart DLLs) |
| Windows x64 + NVIDIA + unknown/no CUDA driver | CPU build |
| Linux x64 + NVIDIA + CUDA 13.x driver | Prebuilt CUDA 13.5 binary (+ bundled CUDA runtime libs) |
| Linux x64 + NVIDIA + CUDA 12.x driver | Prebuilt CUDA 12.8 binary (+ bundled CUDA runtime libs) |
| Linux x64 + NVIDIA + unknown/older CUDA driver | Prebuilt **Vulkan** binary (uses the Vulkan driver shipped with the NVIDIA driver) |
| macOS / Linux arm64 / no NVIDIA | CPU build |

Detection uses `nvidia-smi` plus the NVIDIA driver library (`nvcuda.dll` / `libcuda.so.1`) to read the CUDA driver-API version. The installed variant shows in the Dependencies window as the version label, e.g. `b12182 (cuda-12.4)`, `b12182 (cuda-13.5)` or `b12182 (vulkan)`.

Force a specific build with `CLARA_LLAMA_SERVER_CUDA`:

| Value | Result |
| ----- | ------ |
| `auto` (default) | Use the auto-detected build from the table above |
| `cpu` | Always install the CPU build |
| `cuda-12` | Force the CUDA 12 prebuilt (12.4 on Windows x64, 12.8 on Linux x64) |
| `cuda-13` | Force the CUDA 13.5 prebuilt (Windows x64, Linux x64) |
| `vulkan` | Force the Vulkan prebuilt (Linux/Windows x64) |
| `compile` | Compile from source with `-DGGML_CUDA=ON` (Linux). Requires `cmake`, `gcc`, and the NVIDIA CUDA toolkit; the installer errors with a clear message listing what's missing before attempting the build |

> **Note:** The Linux CUDA prebuilts bundle `libcudart`/`libcublas`, so no CUDA toolkit is needed, only the NVIDIA driver. `b10867` and older don't have them; if you pin an older release with `CLARA_LLAMA_SERVER_VERSION`, force `vulkan` too. `compile` is still available if you want a build tuned to your own GPU.

Pin a different llama.cpp release with `CLARA_LLAMA_SERVER_VERSION` (e.g. `b12182`).

Managed chat servers keep llama-server's default 8 GiB host-RAM prompt cache, which restores a conversation quickly after its prompt changes. On a machine with under 24 GiB of RAM they start with `--cache-ram 2048` instead. A `--cache-ram <MiB>` in the run command always wins (`0` turns the cache off).

</details>

### Code signing (Windows)

Release builds are signed through [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/). The release workflow passes three repository secrets to the build: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. They belong to a Microsoft Entra app registration that holds the Certificate Profile Signer role on the signing account. The account, profile and publisher name are in `scripts/windows-signing.mjs`.

- A local `npm run pack` has none of the three and builds unsigned.
- With all three set, the app and its installer are signed, then checked for a valid signature from the publisher. A failed check fails the build.
- Only ClaraCoder's own programs are signed (`win.signExts` in `electron-builder.yml`). The bundled Python, node and ripgrep keep the signatures they came with.
- A release in this repository fails without the secrets instead of going out unsigned (`CLARA_REQUIRE_SIGNING`). A fork builds unsigned.

A signed app only installs an update signed by the same publisher (name, organization and country). Changing the certificate's name therefore cuts existing installs off from updates.

### Day-to-day commands

| Command                     | Purpose |
| --------------------------- | ------- |
| `npm run dev`               | Development (UI + Electron + Python backend) |
| `npm run build`             | Compile main process + Angular for production |
| `npm run pack`              | Bundle portable Python + core deps, verify unpacked runtime, build installer (`.exe`, `.dmg`, Linux `.deb`/AppImage) |
| `npm run pack:dir`          | Same as `pack`, but stops at the unpacked app directory (no installer) |
| `npm run bundle:python`     | Fetch portable CPython, install requirements into the bundle, write runtime manifest |
| `npm run bundle:vtsls`      | Assemble the bundled TypeScript/JavaScript language server into `vtsls-bundle/` |
| `npm run bundle:rg`         | Fetch the pinned ripgrep binary into `runtime-bundle/ripgrep/` |
| `npm run rebuild:sqlite` / `rebuild:pty` | Force-rebuild `better-sqlite3` / `node-pty` for the pinned Electron |
| `npm run setup:python`      | Create `.venv` if needed; install deps + GPU PyTorch + Kokoro |
| `npm run setup:python:cpu`  | Same without CUDA — CPU-only PyTorch |
| `npm run check:python-deps` | Lint Python dependency graph (`deptry`) |
| `npm run test`              | Renderer unit tests (Angular + Vitest) |
| `npm run test:node`         | Electron main / preload / shared / scripts unit tests |
| `npm run gen:theme-registry` | Regenerate the theme group registry from `data-theme-group` attributes (also runs before `dev`, `build`, and `test`) |
| `npm run check:theme-registry` | Fail when the committed registry is stale |

### Environment overrides

| Variable             | Purpose |
| -------------------- | ------- |
| `CLARA_PYTHON`       | Dev only: absolute path to Python executable (skips auto `.venv` detection). Ignored in packaged builds. |
| `CLARA_PYTORCH_CPU=1` | Same as `setup:python:cpu` — CPU-only PyTorch |
| `PYTHON`             | Base interpreter for creating `.venv` if it does not exist yet |
| `DEV_SERVER_URL`     | Set automatically by `npm run dev` |
| `CLARA_LLAMA_SERVER_VERSION` | Pin a llama.cpp release tag for the managed `llama-server` dep (e.g. `b12182`) |
| `CLARA_LLAMA_SERVER_CUDA` | Force the `llama-server` build variant: `auto` (default) \| `cpu` \| `cuda-12` \| `cuda-13` \| `vulkan` \| `compile` |
| `CLARA_FASTEMBED_THREADS` | ONNX Runtime CPU threads for the in-process workspace embedder (`0` = auto, `min(4, cores)`). Lower it if background indexing competes with a CPU-offloaded `llama-server` |

---

## Troubleshooting

### `setup:python` fails on Python 3.13

Ensure Git is installed and reachable. On 3.13, Kokoro falls back to cloning [hexgrad/misaki](https://github.com/hexgrad/misaki) and [hexgrad/kokoro](https://github.com/hexgrad/kokoro). Re-run:

```bash
npm run setup:python
```

### `No Python 3.10–3.13 found` / venv creation fails

Install Python 3.10+ with the venv module, then re-run:

```bash
npm run setup:python
```

To recreate from scratch: `rm -rf .venv && npm run setup:python`.

### Backend uses the wrong Python

Dev mode prefers `<repo>/.venv/bin/python` (or `.venv\Scripts\python.exe`). If that venv is missing, it falls back to system `python3`. Run `npm run setup:python` or set `CLARA_PYTHON`. Packaged builds use only the bundled runtime.

### Native modules (`better-sqlite3` / `node-pty`)

`better-sqlite3` 13 ships a Node-API binary for each platform inside its package. That binary works in every Node and Electron version, so it is never compiled here, and `npm run rebuild:sqlite` only confirms that Electron loads it.

`node-pty` 1.1 also ships a Node-API binary, for Windows and macOS only. There `npm install` and `npm run dev` only check that Electron loads it and compile nothing while it does; on Linux they compile it from source. If you see `NODE_MODULE_VERSION` / `was compiled against a different Node.js version`, or the terminal is broken, run `npm run rebuild:pty` to compile it from source for this repo's Electron. When that rebuild fails and Electron can still load the addon from its prebuilt binary, the command still passes.

Compiling `node-pty` on Windows may require **MSVC Spectre-mitigated libraries** (Visual Studio Installer → Individual components). If you cannot install them locally, set `CLARA_ALLOW_WIN_PTY_NON_SPECTRE=1` before `npm run rebuild:pty` for a non-Spectre local build (see `scripts/rebuild-native.mjs`).

### Kokoro / TTS errors at runtime

Confirm Kokoro imports in your venv (see step 4 above). For English OOD fallback, install **espeak-ng** on your OS.

On NVIDIA GPUs, Kokoro uses CUDA via PyTorch. If TTS is slow or falls back to CPU, verify the GPU check in step 4 and reinstall with `npm run setup:python`.

---

## Project layout

| Path                       | Role |
| -------------------------- | ---- |
| `src/main/`                | Electron main process (TypeScript) |
| `src/preload/`             | Preload bridge between the renderer and main process |
| `src/renderer/`            | Angular UI ([src/renderer/README.md](src/renderer/README.md)) |
| `src/shared/`              | Types shared by main and renderer; `theme/` holds the theme schema, token catalog, generated group registry, and built-in themes |
| `python/`                  | FastAPI backend (`server.py`, `clara_coder_backend/`) |
| `.venv/`                   | Project Python environment (gitignored; created by `setup:python`) |
| `scripts/`                 | Build, bundling, native-rebuild, and theme-registry scripts (`setup-python.mjs` creates `.venv` and installs PyTorch + deps + Kokoro) |
| `docs/media/`              | README screenshots and clips, plus the [press kit](docs/media/README.md) |
| `tests/branch-smoke/`      | Local, gitignored smoke scripts for a branch ([README](tests/branch-smoke/README.md)) |
