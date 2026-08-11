# Probe Prompt Template (grok-4.5)

Fill in the placeholders before spawning the probe `Task` subagent. Use this template for both folder probes and layer probes (set `PROBE_KIND` accordingly).

## How to use

Spawn one `Task` subagent per folder (or per layer, if `broad`) with:

```
subagent_type: "explore"
model: "cursor-grok-4.5-high-fast"
run_in_background: true
```

Pass the filled-in prompt below as the `prompt` argument. Launch all probes in a single message so they run in parallel.

## Template

```
You are a probe agent in the probe-divide-refactor workflow. Your job is to
report what is in {PROBE_TARGET} that is relevant to a refactor, so a later
planner agent can produce a focused refactor plan.

PROBE_KIND: {PROBE_KIND}            # "folder" or "layer"
PROBE_TARGET: {PROBE_TARGET}        # folder path (relative to workspace root) OR layer name
CRITERIA: {CRITERIA}                 # hardening | optimization | efficiency | security | <user-named>
SCOPE: {SCOPE}                       # explicit boundaries the user named, or "none given"
PURPOSE_STATEMENT (verbatim):
"""
{USER_PURPOSE_STATEMENT}
"""

If PROBE_KIND is "folder": investigate ONLY files under {PROBE_TARGET}. Do not
descend into skipped folders (node_modules, .git, dist, build, .next, coverage,
.agents, .cursor, .vscode, target, out).

If PROBE_KIND is "layer": investigate across all folders for the {PROBE_TARGET}
layer only (front-end | back-end | infra). Skip the same folders as above.

Report, framed against the PURPOSE_STATEMENT and CRITERIA:

1. Framework / components — what framework is in use, which component files exist.
2. Modules — logical modules and their entry points.
3. Features — user-facing or system features implemented here.
4. Inputs / outputs — what this area consumes and produces (APIs, files, queues,
   DB tables, events).
5. Business logic — non-obvious rules, state machines, validation, auth checks.

STRICT OUTPUT CONTRACT — follow exactly:

- File-path-first, line-number-attached, backticked symbols.
- One section per category above, then a totals line.
- ≤300 tokens total. If you exceed this, drop the least relevant findings.
- No prose, no preamble, no summary paragraph. Just the structured list.
- Format example:

  <PROBE_TARGET>: components/modules
  - path/to/file.ts:12 — `symbol` — short note tied to CRITERIA
  - path/to/other.ts:45 — `otherSymbol` — short note
  totals: N findings.

If nothing relevant exists in {PROBE_TARGET}, return exactly:
  No match.

Do not propose fixes. Do not write plans. Just report what is here.
```

## Placeholders

| Placeholder | Source |
|---|---|
| `PROBE_KIND` | `folder` for folder probes; `layer` for the extra cross-folder probes when `broad` is set. |
| `PROBE_TARGET` | Folder path relative to workspace root, or one of `front-end` / `back-end` / `infra`. |
| `CRITERIA` | From Step 1 of the skill. |
| `SCOPE` | From Step 1, or the literal string `none given`. |
| `USER_PURPOSE_STATEMENT` | The user's verbatim purpose statement. Do not paraphrase. |

## Notes for the main agent

- Folder probes and layer probes can be launched together in the same message.
- If a probe returns prose instead of the contract, re-prompt that one probe with the contract emphasized; do not re-run all probes.
- Aggregate results in Step 3 of the skill (dedupe + group).
