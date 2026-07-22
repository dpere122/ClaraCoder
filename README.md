# Clara Coder

Electron desktop app with an Angular UI and a Python (FastAPI) backend for AI-assisted coding: chat, workspace tools, LSP integration, transcription, and local Kokoro TTS.

For backend API details, env vars, and layout, see [python/README.md](python/README.md).

## First-time build

These steps get a fresh clone running in development. Allow roughly 5–15 minutes depending on network speed (PyTorch and Kokoro are the slow parts).

### Prerequisites


| Tool                 | Notes                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node.js + npm**    | Required for Electron, Angular, and native addon rebuilds. The renderer pins `npm@11.9.0`; any recent npm 11.x is fine.                                                                                                        |
| **Python 3.10–3.13** | 3.13 works out of the box. Create a venv with your system `python3` — you do **not** need a separate 3.12 install.                                                                                                             |
| **Git**              | Required on Python 3.13+ so `setup:python` can install Kokoro/misaki from GitHub until PyPI publishes 3.13 wheels.                                                                                                             |
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
npm install --prefix src/renderer
```

Root `npm install` runs `postinstall`, which rebuilds native Electron modules (`node-pty`, `better-sqlite3`) for the pinned Electron version.

### 2. Create the Python virtual environment

Use a venv at the **repo root** (`.venv/`). In dev, the app auto-detects this interpreter.

**macOS / Linux**

```bash
python3 -m venv .venv
```

**Windows (PowerShell)**

```powershell
python -m venv .venv
```

On Debian/Ubuntu, if `ensurepip` is missing, install `python3-venv` (or `python3.13-venv`) first.

### 3. Install Python dependencies (including Kokoro TTS)

Still from the repo root:

```bash
npm run setup:python
```

Use `setup:python` when you have an NVIDIA GPU (installs CUDA PyTorch `cu129`, required for RTX 50-series / Blackwell). Use `npm run setup:python:cpu` on machines without CUDA.

What this script does:

1. Installs everything in `python/requirements.txt` (FastAPI, LangChain, LSP, etc.).
2. Installs **Kokoro TTS**:
  - **Python 3.10–3.12** — `kokoro` from PyPI (`python/requirements-kokoro-pypi.txt`).
  - **Python 3.13+** — `misaki` and `kokoro` from GitHub plus `spacy>=3.8.14` (PyPI wheels still cap at `<3.13`).

Do **not** rely on `pip install -r python/requirements.txt` alone — Kokoro is installed only through `setup:python`.

Override the interpreter if needed:

```bash
PYTHON=/path/to/python3 npm run setup:python:cpu
```



### 4. Run the app

```bash
npm run dev
```

This starts:

- Angular dev server at `http://127.0.0.1:4200`
- TypeScript watch build for the Electron main process
- Electron with hot reload (`electronmon`)

Use the **Electron window** for the full app. Do not use `npm run start` for development — that expects a pre-built UI under `dist/renderer/`.

Stop dev with **Ctrl+C** in the terminal running `npm run dev`.

### 5. Verify the setup (optional)

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
npm run build
npm run pack:dir
```

Packaged output lands under `release/` (or `release-pack-<timestamp>/` if the folder is locked on Windows).

---



## Day-to-day commands


| Command                     | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `npm run dev`               | Development (UI + Electron + Python backend)           |
| `npm run build`             | Compile main process + Angular for production          |
| `npm run pack`              | Build installer (`.exe`, `.dmg`, etc.)                 |
| `npm run setup:python`      | Reinstall Python deps + GPU PyTorch + Kokoro (NVIDIA)  |
| `npm run setup:python:cpu`  | Same without CUDA — CPU-only PyTorch                   |
| `npm run check:python-deps` | Lint Python dependency graph (`deptry`)                |




## Environment overrides


| Variable             | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `NEMO_PYTHON`        | Absolute path to Python executable (skips auto `.venv` detection) |
| `NEMO_PYTORCH_CPU=1` | Same as `setup:python:cpu` — CPU-only PyTorch                     |
| `PYTHON`             | Interpreter used by `scripts/setup-python.mjs`                    |
| `DEV_SERVER_URL`     | Set automatically by `npm run dev`                                |




## Troubleshooting



### `setup:python` fails on Python 3.13

Ensure Git is installed and reachable. The 3.13 path clones [hexgrad/misaki](https://github.com/hexgrad/misaki) and [hexgrad/kokoro](https://github.com/hexgrad/kokoro). Re-run:

```bash
npm run setup:python
```



### `No Python 3.10–3.13 found`

Install Python 3.10 or newer, recreate `.venv`, and run setup again:

```bash
python3 -m venv .venv
npm run setup:python
```



### Backend uses the wrong Python

Dev mode prefers `<repo>/.venv/bin/python` (or `.venv\Scripts\python.exe`). If that venv is missing, it falls back to system `python3`. Create `.venv` at the repo root or set `NEMO_PYTHON`.

### Windows native modules

`node-pty` may require **MSVC Spectre-mitigated libraries** (Visual Studio Installer → Individual components). If you cannot install them locally, set `NEMO_ALLOW_WIN_PTY_NON_SPECTRE=1` before `npm install` for a non-Spectre local build (see `scripts/rebuild-native.mjs`).

### Kokoro / TTS errors at runtime

Confirm Kokoro imports in your venv (see step 5 above). For English OOD fallback, install **espeak-ng** on your OS.

On NVIDIA GPUs, Kokoro uses CUDA via PyTorch. If TTS is slow or falls back to CPU, verify the GPU check in step 5 and reinstall with `npm run setup:python`.

## Project layout (short)


| Path                       | Role                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `src/main/`                | Electron main process (TypeScript)                           |
| `src/renderer/`            | Angular UI                                                   |
| `python/`                  | FastAPI backend (`server.py`, `nemo_backend/`)               |
| `.venv/`                   | Project Python environment (gitignored; create at repo root) |
| `scripts/setup-python.mjs` | Python + Kokoro installer used by `npm run setup:python`     |


