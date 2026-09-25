# Clara Coder

Electron desktop app with an Angular UI and a Python (FastAPI) backend for AI-assisted coding: chat, workspace tools, LSP integration, transcription, and local Kokoro TTS.

For the dual-stack backend map (Electron IPC + FastAPI/LangGraph, tools, persistence), see [docs/backend-architecture.md](docs/backend-architecture.md). For Python API details, env vars, and layout, see [python/README.md](python/README.md).

## First-time build

These steps get a fresh clone running in development. Allow roughly 5–15 minutes depending on network speed (PyTorch and Kokoro are the slow parts).

### Prerequisites


| Tool                 | Notes                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node.js + npm**    | Required for Electron, Angular, and native addon rebuilds. The repo pins `npm@11.9.0`; any recent npm 11.x is fine.                                                                                                           |
| **Python 3.10–3.13** | One system Python is enough. `npm run setup:python` creates the repo-root `.venv` for you — you do **not** need a separate 3.12 install.                                                                                        |
| **Git**              | Needed when Kokoro cannot install from PyPI (today: Python 3.13+); `setup:python` falls back to GitHub for misaki/kokoro.                                                                                                      |
| **Build toolchain**  | Linux/macOS: compiler + Python headers for `node-pty` / `better-sqlite3` rebuilds (`build-essential`, `python3-venv`, etc.). Windows: Visual Studio Build Tools; see [node-pty / Spectre note](#windows-native-modules) below. |


Optional:

- **espeak-ng** — improves Kokoro English fallback for out-of-vocabulary words ([Kokoro docs](https://pypi.org/project/kokoro/)).
- **OpenAI API key** or **LM Studio** — configured in the app after launch, not at build time.



### 1. Clone and install Node dependencies

From the repository root:

```bash
git clone <repo-url> ClaraCoder
cd ClaraCoder
npm install
```

One root `package.json` covers Electron and the Angular UI. `postinstall` rebuilds native Electron modules (`node-pty`, `better-sqlite3`) for the pinned Electron version. `npm run dev`, `npm start`, and `npm run pack` also check those addons and rebuild if they were compiled for a different Node/Electron ABI (for example after copying `node_modules` between machines). Prefer `npm install` on each device rather than copying `node_modules` across OS or CPU architectures.

If you previously had a separate `src/renderer/node_modules` (or an old workspace install), clean once and reinstall:

```bash
rm -rf node_modules src/renderer/node_modules
npm install
```

### 2. Install Python dependencies (including Kokoro TTS)

From the repo root:

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

**GPU PyTorch (NVIDIA)**

```bash
.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')"
```

Expect `2.13.0+cu129` and your GPU name. RTX 50-series (Blackwell) needs `cu129`; if you see a CPU build (`+cpu`) or sm_120 warnings, re-run `npm run setup:python` (not `setup:python:cpu`).

**Renderer tests**

```bash
npm test
```

**Production-style build**

```bash
npm run pack:dir
```

`pack` / `pack:dir` run `bundle:python` first (downloads a portable CPython into `runtime-bundle/python/`, installs `python/requirements.txt` into that interpreter, and writes `.clara-runtime-manifest.json`), then compile and invoke electron-builder. After a successful pack, `scripts/verify-packed-runtime.mjs` checks the unpacked resources (interpreter, manifest, backend sources, vtsls). Packaged output lands under `release/` (or `release-pack-<timestamp>/` if the folder is locked on Windows).

In packaged builds only the bundled runtime is used. `CLARA_PYTHON`, the repo-root `.venv`, and system Python apply to development only.

To regenerate `python/requirements.lock` from the bundled interpreter:

```bash
npm run bundle:python -- --force --write-lock
```

On **Linux**, `npm run pack` builds a `.deb` and an AppImage. Prefer the `.deb` on Debian/Ubuntu. The AppImage needs FUSE 2 (`libfuse.so.2`); on Debian 13 / Ubuntu 24.04+ install `libfuse2t64` first, or run with `APPIMAGE_EXTRACT_AND_RUN=1`.

**Agent PATH on packaged launches**

Desktop launchers give the app a stripped GUI `PATH`, so agent `run_command` cannot find CLIs that work in a login terminal (`gh`, `cargo`, `~/.local/bin`, nvm/fnm/asdf shims, Homebrew, …). The workspace terminal is unaffected — it is an interactive shell that sources your profile.

Clara Coder reconstructs user bins once at startup (login-shell `PATH` probe + well-known directories that exist) and applies that to the sidecar that agent commands inherit. Add extra directories in **Settings → Tools → Extra PATH directories** (one per line). The login probe reads `PATH` only; it does not copy API keys or other profile secrets into agent env.

**Dependencies window**

After install (or in dev), open **Dependencies** to download optional runtime pieces into app data (`runtime/`):

| Dependency | Purpose |
| ---------- | ------- |
| Python runtime | App-managed venv + core backend packages |
| llama-server | Managed local llama.cpp binary (no system install required) |
| Java LSP (JDT LS) | Eclipse JDT Language Server for Java |
| Kokoro TTS | Local neural TTS (CPU PyTorch + kokoro) |

Heavy pieces are on-demand; the packaged app ships a portable Python with core backend packages plus the backend sources.

#### llama-server GPU acceleration (auto-detected)

The `llama-server` installer probes the host and picks a GPU-accelerated build when one is available, falling back to CPU otherwise:

| Host | Build selected |
| ---- | -------------- |
| Windows x64 + NVIDIA + CUDA 13.x driver | Prebuilt CUDA 13.3 binary (+ bundled cudart DLLs) |
| Windows x64 + NVIDIA + CUDA 12.x driver | Prebuilt CUDA 12.4 binary (+ bundled cudart DLLs) |
| Windows x64 + NVIDIA + unknown/no CUDA driver | CPU build |
| Linux x64 + NVIDIA | Prebuilt **Vulkan** binary (uses the Vulkan driver shipped with the NVIDIA driver; no CUDA toolkit needed) |
| macOS / Linux arm64 / no NVIDIA | CPU build |

Detection uses `nvidia-smi` plus the NVIDIA driver library (`nvcuda.dll` / `libcuda.so.1`) to read the CUDA driver-API version. The installed variant shows in the Dependencies window as the version label, e.g. `b10867 (cuda-12.4)` or `b10867 (vulkan)`.

Force a specific build with `CLARA_LLAMA_SERVER_CUDA`:

| Value | Result |
| ----- | ------ |
| `auto` (default) | Use the auto-detected build from the table above |
| `cpu` | Always install the CPU build |
| `cuda-12` | Force the Windows CUDA 12.4 prebuilt (Windows x64 only) |
| `cuda-13` | Force the Windows CUDA 13.3 prebuilt (Windows x64 only) |
| `vulkan` | Force the Vulkan prebuilt (Linux/Windows x64) |
| `compile` | Compile from source with `-DGGML_CUDA=ON` (Linux). Requires `cmake`, `gcc`, and the NVIDIA CUDA toolkit; the installer errors with a clear message listing what's missing before attempting the build |

> **Note:** ggml-org does **not** publish Linux CUDA prebuilts, so true CUDA on Linux is opt-in via `compile` and needs the CUDA toolkit. For most Linux + NVIDIA users the Vulkan default gives GPU acceleration without any extra setup.

Pin a different llama.cpp release with `CLARA_LLAMA_SERVER_VERSION` (e.g. `b10867`).

Managed chat servers are started with `--cache-ram 0` unless the run command already sets `--cache-ram`. llama-server's default is an 8 GiB host-RAM prompt cache that fills up whenever the prompt prefix changes (for example when the workspace tree in the system prompt changes mid-session), which looks like a steady RAM leak at large contexts. Add `--cache-ram <MiB>` to the run command to opt back in.

---



## Day-to-day commands


| Command                     | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `npm run dev`               | Development (UI + Electron + Python backend)           |
| `npm run build`             | Compile main process + Angular for production          |
| `npm run pack`              | Bundle portable Python + core deps, verify unpacked runtime, build installer (`.exe`, `.dmg`, Linux `.deb`/AppImage)|
| `npm run bundle:python`     | Fetch portable CPython, install requirements into the bundle, write runtime manifest |
| `npm run setup:python`      | Create `.venv` if needed; install deps + GPU PyTorch + Kokoro |
| `npm run setup:python:cpu`  | Same without CUDA — CPU-only PyTorch                   |
| `npm run check:python-deps` | Lint Python dependency graph (`deptry`)                |
| `npm run test`              | Renderer unit tests (Angular + Vitest)                 |
| `npm run test:node`         | Electron main / preload / shared / scripts unit tests  |
| `npm run gen:theme-registry` | Regenerate the theme group registry from `data-theme-group` attributes (also runs before `dev`, `build`, and `test`) |
| `npm run check:theme-registry` | Fail when the committed registry is stale           |



## Themes

The UI is painted by a theme engine (`src/renderer/src/app/core/theme`, shared schema in `src/shared/theme`).
A theme is a JSON document — global design tokens (`--t-*`), per-element-group overrides, optional
background images, and an optional Monaco palette. Two read-only built-ins ship (`clara-dark`, `clara-light`);
user themes live under `{userData}/themes/<id>/theme.json` with images in `assets/`.

### Using themes

- **Settings → Themes → Theme library**: pick the active theme, create one from the selection, duplicate,
  import / export a `.clara-theme.json` bundle (images are embedded), or delete. Every change previews live in
  all windows and is written on **Apply / OK**; closing without saving reverts the preview.
- **Global colors** edits the tokens every element inherits; the per-category panes (Chat, Editor, Shell, …)
  edit one registered element group at a time: scoped token overrides, an **Advanced CSS** block, and — for
  groups that opt in (chat transcript, code editor) — a **background image** with an enable toggle, opacity
  slider, and fit.
- **Editor palette** derives Monaco colors from the tokens; **Customize** snapshots them so individual colors
  and syntax rules can be tuned. Settings → Editor → Color theme → *Follow app theme* (the default) uses it.
- In chat, ask Clara for a theme ("make me a cyberpunk theme"); the `propose_theme` tool posts a card with
  **Preview**, **Save & apply**, **Save only**, and **Dismiss**.

### Theme document

```jsonc
{
  "version": 1,
  "id": "neon-nights",            // lowercase letters, digits, hyphens
  "name": "Neon Nights",
  "mode": "dark",                 // dark | light — picks the built-in used for unset tokens
  "tokens": { "--t-bg": "#101014", "--t-primary": "#ff4fd8" },
  "groups": {
    "chat.transcript": {
      "tokens": { "--t-chat-bg": "#0c0c10" },
      "css": ".msg-bubble { border-radius: 0; } & { box-shadow: none; }",
      "background": { "enabled": true, "asset": "wall", "opacity": 0.35, "fit": "cover" }
    }
  },
  "monaco": { "base": "vs-dark", "colors": { "editor.background": "#101014" }, "rules": [] },
  "assets": { "wall": "wall.png" } // file name on disk, or data:image/… in an exported bundle
}
```

Token names come from `src/shared/theme/theme-tokens.ts`; group ids from the generated registry. Unknown
tokens / groups are dropped with a warning. Group CSS is sanitized (`@import`, remote `url()` / `src()` /
`image-set()`, `expression()`, and CSS escapes outside strings are removed) and contained to the group's root:
every style rule is emitted inside a native `@scope (<root>) { … }` block, so no selector — including
`:not(&)`, `:has(&)`, or sibling combinators — can style elements outside the group. Plain selectors match
descendants, a leading `&` (or `:host`, `:root`) targets the root itself; `@keyframes` / `@font-face` are kept
global. Embedded images must be strict `data:image/…;base64,` URLs.

### Registering a new element group (for contributors)

1. Put `data-theme-group="<category>.<name>"` on the root element of the component template (or in the
   component's `host` metadata). Ids are lowercase with hyphens, one dot.
2. Run `npm run gen:theme-registry`. The script infers the label, category, scope selector, and the `--t-*`
   tokens the component's stylesheet uses, and rewrites `src/shared/theme/theme-registry.generated.ts` and
   `python/clara_coder_backend/theme/registry.json`. The new group appears in Settings → Themes under its
   category and becomes valid for agent proposals automatically.
3. Optional `*.theme.json` manifest next to the template to set `label`, `description`, `categories` labels,
   extra `tokens`, `styleSources` (other folders whose CSS the group covers), `supportsBackground: true`
   (root must be `position: relative`), and `backgroundClear` (inner selectors made transparent while an
   overlay is active).



## Environment overrides


| Variable             | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `CLARA_PYTHON`        | Dev only: absolute path to Python executable (skips auto `.venv` detection). Ignored in packaged builds. |
| `CLARA_PYTORCH_CPU=1` | Same as `setup:python:cpu` — CPU-only PyTorch                     |
| `PYTHON`             | Base interpreter for creating `.venv` if it does not exist yet    |
| `DEV_SERVER_URL`     | Set automatically by `npm run dev`                                |
| `CLARA_LLAMA_SERVER_VERSION` | Pin a llama.cpp release tag for the managed `llama-server` dep (e.g. `b10867`) |
| `CLARA_LLAMA_SERVER_CUDA` | Force the `llama-server` build variant: `auto` (default) \| `cpu` \| `cuda-12` \| `cuda-13` \| `vulkan` \| `compile` |
| `CLARA_FASTEMBED_THREADS` | ONNX Runtime CPU threads for the in-process workspace embedder (`0` = auto, `min(4, cores)`). Lower it if background indexing competes with a CPU-offloaded `llama-server` |




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

These addons must match this repo's Electron ABI, not system Node. If you see `NODE_MODULE_VERSION` / `was compiled against a different Node.js version`, run `npm run rebuild:sqlite` (and `npm run rebuild:pty` if the terminal is broken). `npm run dev` does that check automatically.

`node-pty` on Windows may require **MSVC Spectre-mitigated libraries** (Visual Studio Installer → Individual components). If you cannot install them locally, set `CLARA_ALLOW_WIN_PTY_NON_SPECTRE=1` before `npm install` for a non-Spectre local build (see `scripts/rebuild-native.mjs`).

### Kokoro / TTS errors at runtime

Confirm Kokoro imports in your venv (see step 5 above). For English OOD fallback, install **espeak-ng** on your OS.

On NVIDIA GPUs, Kokoro uses CUDA via PyTorch. If TTS is slow or falls back to CPU, verify the GPU check in step 5 and reinstall with `npm run setup:python`.

## Project layout (short)


| Path                       | Role                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `src/main/`                | Electron main process (TypeScript)                           |
| `src/renderer/`            | Angular UI                                                   |
| `src/shared/theme/`        | Theme schema, token catalog, generated group registry, built-in themes |
| `python/`                  | FastAPI backend (`server.py`, `clara_coder_backend/`)               |
| `.venv/`                   | Project Python environment (gitignored; created by `setup:python`) |
| `scripts/setup-python.mjs` | Creates `.venv`, installs PyTorch + deps + Kokoro             |


