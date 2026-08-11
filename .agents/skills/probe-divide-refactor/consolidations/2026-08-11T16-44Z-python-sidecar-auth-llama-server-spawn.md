# Consolidation Overlap Report — python-sidecar-auth + llama-server-spawn

- **Generated (UTC):** 2026-08-11T16:44Z
- **Base branch:** master
- **Component PRs reviewed:**
  - PR #10 `security/python-sidecar-auth` — boundary: `python/clara_coder_backend/**` + `src/main/python/**`
  - PR #11 `security/llama-server-spawn` — boundary: `src/main/llama-server-manager.ts` only

## 1. Shared files

Files modified in more than one component branch.

| File | PR #10 | PR #11 |
|------|--------|--------|
| _(none)_ | — | — |

No files are modified by both branches. The two boundaries are textually disjoint.

## 2. Duplicated logic

Same logical change introduced independently in two branches.

_(none observed)_

- PR #10 concerns Python-sidecar HTTP auth (adds `http_guards`, workspace/paths hardening, authenticated `http-client.ts`/`server.ts`/`workspace-sync.ts`).
- PR #11 concerns the llama-server spawn path in `src/main/llama-server-manager.ts`.
- No overlapping helpers, constants, types, or auth tokens are introduced by both branches.

## 3. Boundary violations

A branch touched files outside its declared boundary list.

| Branch | Declared boundary | Actual diff | Violation? |
|--------|------------------|-------------|------------|
| `security/python-sidecar-auth` (PR #10) | `python/clara_coder_backend/**` + `src/main/python/**` | `python/clara_coder_backend/domain.py`, `python/clara_coder_backend/main.py`, `python/clara_coder_backend/routes/runtime.py`, `python/clara_coder_backend/tools/http_guards.py`, `python/clara_coder_backend/tools/run_command.py`, `python/clara_coder_backend/workspace/paths.py`, `src/main/python/http-client.ts`, `src/main/python/server.ts`, `src/main/python/workspace-sync.ts` | **No** — all 9 files are within `python/clara_coder_backend/**` or `src/main/python/**`. |
| `security/llama-server-spawn` (PR #11) | `src/main/llama-server-manager.ts` only | `src/main/llama-server-manager.ts` | **No** — single file, exactly the declared boundary. |

No boundary violations detected.

## 4. Cross-session follow-up plans

Overlaps spanning components — NOT implemented this session. Each entry below is a proposal for a future consolidation/component session.

### 4.1 `sidecar-auth-coverage`

- **Branches involved:** `security/python-sidecar-auth` (PR #10), plus future components `ipc-trust-guards` and `tts-ssrf-errorleak`.
- **Overlap description:** PR #10 introduces an authenticated Python-sidecar HTTP client (`src/main/python/http-client.ts`) and server-side guards, but several existing callers still issue bare `fetch` calls to the sidecar and bypass the new auth path. These callers are owned by other components or by a later consolidation pass, so they were intentionally left out of PR #10's boundary.
- **Out-of-scope callers flagged during review:**
  - `src/main/ipc/handlers/conversations.ts`
  - `src/main/ipc/handlers/health.ts`
  - `src/main/ipc/handlers/audio-tts.ts`
  - `src/main/tts/kokoro/fetch.ts`
  - `src/main/log-ingest.ts`
  - `python/clara_coder_backend/tools/fetch_url.py` (DNS-rebind wiring)
- **Follow-up plan sketch:**
  1. Audit each listed caller for current sidecar URL construction and header usage.
  2. Replace bare `fetch(...)` with the authenticated client exported from `src/main/python/http-client.ts`; for the Python-side `fetch_url.py`, route through the server-side guard added in `python/clara_coder_backend/tools/http_guards.py` (or a thin wrapper) so DNS-rebind and SSRF protections apply.
  3. Open a dedicated component PR `security/sidecar-auth-coverage` scoped to exactly the files above; coordinate with `ipc-trust-guards` (IPC handler hardening) and `tts-ssrf-errorleak` (TTS SSRF/error-leak) to avoid re-touching the same files.
  4. Consolidation step: re-run this overlap report after those PRs open to confirm the coverage branch does not collide with `ipc-trust-guards` or `tts-ssrf-errorleak`.

### 4.2 _(placeholder for future overlaps)_

No other cross-component overlaps exist between PR #10 and PR #11 at this time. Add entries here as new component PRs open.

## 5. Summary

- **Shared files:** none.
- **Duplicated logic:** none.
- **Boundary violations:** none.
- **Cross-session follow-ups:** 1 (`sidecar-auth-coverage`) — spans PR #10 plus not-yet-opened `ipc-trust-guards` / `tts-ssrf-errorleak` components; out-of-scope bare-sidecar callers listed for a future coverage pass.

The two component boundaries (`python/clara_coder_backend/**` + `src/main/python/**` vs `src/main/llama-server-manager.ts`) are disjoint. PR #10 and PR #11 may be merged independently.
