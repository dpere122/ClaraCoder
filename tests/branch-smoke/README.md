# Branch-specific smoke tests

This folder is a **local scratch space** for ad-hoc smoke tests that target a specific branch or PR
(e.g. the `security/*` refactor branches). It is intentionally **not** part of the committed
test suite.

## What lives here

- `README.md` (this file) — the only tracked file in this directory.
- `*.sh`, `*.py` (and any other test files you drop here) — **gitignored**, local only.

Committed tests belong in `python/tests/` (pytest) or next to the source as `*.spec.ts`
(vitest). Use this folder for throwaway smoke checks you want to run while a branch is
checked out, without polluting the repo or CI.

## Why it is gitignored

Branch smoke tests are frequently environment-specific (they hit the local sidecar —
`127.0.0.1:5123` for the installed app, `127.0.0.1:5124` under `npm run dev` — assume a
running llama server, carry local tokens, etc.) and are not meant to gate
merge. Only this README is tracked; every other file under this directory is
ignored (see `.gitignore`):

```
/tests/branch-smoke/*
!/tests/branch-smoke/README.md
```

## Convention for a test file

A test file is a small executable script that:

1. Prints what it is doing to stdout.
2. Exits `0` on success, non-zero on failure.
3. Needs no arguments — it can assume the app/sidecar is already running locally
   (or it skips with a clear message if not).

Example shape (`tests/branch-smoke/sidecar-auth.sh`):

```bash
#!/usr/bin/env bash
set -u
PYTHON_URL="${PYTHON_URL:-http://127.0.0.1:5123}"   # 5124 when testing `npm run dev`
TOKEN="${TOKEN:-}"                       # or run sidecar with CLARA_SIDECAR_AUTH_OPTIONAL=1
auth=(); [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")

# /health is the one auth-exempt route, so probe a protected one
echo "missing token -> expect 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "$PYTHON_URL/lsp/status")
[ "$code" = "401" ] || { echo "FAIL: got $code"; exit 1; }
echo "  ok ($code)"
```

## How to run all of them (output to the console)

From the repo root:

```bash
# run every shell test
for f in tests/branch-smoke/*.sh; do
  [ -e "$f" ] || continue
  echo "=== $f ==="
  bash "$f" && echo "  -> ok" || echo "  -> FAIL (exit $?)"
done

# run every python test
for f in tests/branch-smoke/*.py; do
  [ -e "$f" ] || continue
  echo "=== $f ==="
  python "$f" && echo "  -> ok" || echo "  -> FAIL (exit $?)"
done
```

Each script's own stdout prints inline, so you see the live output in the console.
A non-zero exit is reported as `FAIL` for that file.

## Tips

- Name files by branch/feature, e.g. `sidecar-auth.sh`, `llama-spawn.sh`,
  `tts-ssrf.sh`, so it's obvious which PR they exercise.
- Keep them idempotent and fast; they are smoke checks, not full unit tests.
- If a check here becomes worth keeping, promote it into `python/tests/` or a
  `*.spec.ts` and delete it from this folder.
