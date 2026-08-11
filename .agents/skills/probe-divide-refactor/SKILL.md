---
name: probe-divide-refactor
description: >-
  Multi-agent refactor orchestrator. Probes the codebase with one grok-4.5 agent
  per folder, groups findings into refactor components, spawns a glm-5.2 planner
  per component on its own branch (user-criteria/component-name), waits for user
  acceptance, then spawns a grok-4.5 swarm to implement, reviews, and opens a PR
  to master per component. A rolling topmost glm-5.2 agent consolidates overlaps
  between branches after each PR. Use when the user provides a refactor purpose
  statement (e.g. "refactor for security", "optimize the ingestion pipeline") and
  wants the work divided into isolated, reviewable component PRs. Trigger:
  "probe-divide-refactor", "refactor in components", "divide refactor into PRs",
  "swarm refactor".
disable-model-invocation: true
---

# Probe-Divide-Refactor

Orchestrates a refactor across a codebase by dividing it into isolated components, each shipped as its own PR to `master`. Heavy multi-agent workflow: grok-4.5 probes, glm-5.2 plans, grok-4.5 implements, glm-5.2 consolidates.

**Input**: a refactor purpose statement from the user, e.g.
- "Refactor for security hardening across the auth and billing areas"
- "Optimize the data ingestion pipeline end-to-end"
- "Refactor for general hardening"

**Models** (must use these exact slugs):
- Probe / implement agents: `cursor-grok-4.5-high-fast`
- Plan / consolidate agents: `glm-5.2-high`

## Workflow

### Step 1 — Parse the purpose statement

Extract two things from the user's statement:

1. **Criteria** — one of `hardening`, `optimization`, `efficiency`, `security`, or a user-named criterion. Slugify if user-named (lowercase, hyphens).
2. **Scope** — explicit pipeline/folder boundaries if the user named any.

Set a `broad` flag when the user gave little detail (no folders, no pipeline, no layers named). The `broad` flag widens Step 2.

### Step 2 — Probe (grok-4.5, one agent per folder)

1. Enumerate top-level folders under the workspace root. Skip: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.agents`, `.cursor`, `.vscode`, `target`, `out`.
2. Spawn **one** `Task` subagent per folder:
   - `subagent_type: "explore"`
   - `model: "cursor-grok-4.5-high-fast"`
   - `run_in_background: true`
   - Launch **all** folder probes in a **single message** (parallel).
   - Prompt each agent with the template in [probe-prompt.md](probe-prompt.md), filling in the folder path, the criteria, the scope, and the user's verbatim purpose statement.
3. If `broad` is set, **also** spawn cross-folder probes split by technology layer (front-end / back-end / infra), one agent per layer, same model/settings. Layer probes report across folders; folder probes report within a folder.
4. **Probe output contract** (every probe agent must follow this): file-path-first, line-number-attached, backticked symbols, ≤300 tokens per folder. Safe to grep with `path:\d+`. Example:

   ```
   <folder>: components/modules
   - src/auth/middleware.ts:12 — `verifyToken` — JWT expiry uses `<` not `<=`
   - src/auth/routes.ts:45 — `loginHandler` — no rate limit
   totals: 2 findings.
   ```

5. Wait for all probes to complete (end-of-turn completion notifications), then aggregate.

### Step 3 — Dedupe and group

Main agent aggregates all probe reports and:

1. Removes duplicate findings (same file:line reported by multiple probes).
2. Groups remaining findings into discrete **refactor components**. A component is a coherent unit of work that can be reviewed and merged independently — e.g. `auth-middleware`, `billing-service`, `ingestion-etl`.
3. Each component gets a **boundary list**: the files/dirs it may touch. Components must not overlap on writeable files. If two findings would force overlapping writes, split them into separate components or push the overlap into Step 7 consolidation.

Output: a component list, each with name, criteria, boundary list, and the probe findings it covers. Show this list to the user before planning.

### Step 4 — Plan per component (glm-5.2, plan mode, per branch)

For each component, spawn a `Task` subagent:

- `subagent_type: "generalPurpose"`
- `model: "glm-5.2-high"`
- `environment: "cloud"` (each gets its own worktree/branch)
- `run_in_background: false`
- Prompt with the template in [plan-prompt.md](plan-prompt.md), filling in: the component name, the criteria, the boundary list, the probe findings, and the user's verbatim purpose statement.

Each glm-5.2 planner agent must:

1. Create a branch named exactly `<criteria>/<component-name>` — lowercase, hyphenated, criteria first. Examples: `security/auth-middleware`, `optimization/ingestion-etl`, `hardening/billing-service`.
2. Enter plan mode and produce a plan grounded in the user's purpose statement and the probe findings for that component.
3. Stay strictly within the boundary list. The plan prompt forbids touching files outside the component.
4. Return the plan to the main agent.

The main agent surfaces each plan to the user for **accept/reject**. Rejected plans go back to the same glm-5.2 agent with the user's feedback (use `resume`). Do not proceed to Step 5 until that plan is accepted.

### Step 5 — Implement (grok-4.5 swarm, after acceptance)

On user acceptance of a component's plan, spawn the implementers on that branch:

- If the plan has **one** independent subtask: spawn a **single** grok-4.5 agent (`subagent_type: "generalPurpose"`, `model: "cursor-grok-4.5-high-fast"`). Do not use a swarm.
- If the plan has **>1** independent subtask: spawn a grok-4.5 swarm — one `best-of-n-runner` per subtask (each gets its own branch), or multiple `generalPurpose` grok agents launched in parallel. Pick `best-of-n-runner` when you want competing attempts of the same subtask; pick parallel `generalPurpose` when subtasks are disjoint.

Swarm agents must:
- Stay within the component's file boundaries (the plan enforces this).
- Not commit; the main agent commits after reviewing the aggregated diff.
- Report what they changed using the caveman-style file-path-first contract.

### Step 6 — Review and PR

1. After implementation, run a review on the branch:
   - If criteria is `security`: use the `security-review` subagent.
   - If criteria is `hardening` or `optimization` or `efficiency`: use the `bugbot` subagent.
   - Otherwise: a `generalPurpose` grok-4.5 reviewer.
2. Fix review findings **within the same branch** (spawn a grok-4.5 agent to apply fixes).
3. Open a PR to `master` for that component branch:
   ```bash
   gh pr create --base master --head <criteria>/<component-name> \
     --title "<criteria>: <component-name> refactor" \
     --body "$(cat <<'EOF'
   ## Purpose
   <user's verbatim purpose statement>

   ## Criteria
   <criteria>

   ## Component boundaries
   <boundary list>

   ## Test plan
   - [ ] Tests pass on this branch
   - [ ] No files outside the boundary list were modified
   EOF
   )"
   ```
   One PR per component. Do not combine components into a single PR.

### Step 7 — Rolling consolidation (topmost glm-5.2)

After **each** component PR is opened (not at the end), spawn one `glm-5.2-high` `generalPurpose` agent — the **topmost agent** — with `run_in_background: false`. It must:

1. List every other already-open component branch (`git branch -r` or `gh pr list --state open --base master --json headRefName`).
2. For each open branch, run `git diff master...<other-branch> --name-only` and `git diff master...<current-branch> --name-only`.
3. Write an **overlap report** to `.agents/skills/probe-divide-refactor/consolidations/<UTC-timestamp>-<component-name>.md` containing:
   - **Shared files** — files modified in more than one component branch.
   - **Duplicated logic** — same change introduced in two branches.
   - **Boundary violations** — a component branch touched files outside its boundary list.
4. Propose **cross-session follow-up plans** for overlaps that span components. These are **not** implemented in this session. Each follow-up is written as a section in the same overlap-report file with: a name, the branches involved, the overlap description, and a sketch of the follow-up plan.

This runs after every component PR, so overlaps are caught incrementally. The main agent should mention new overlap reports to the user as they appear.

### Step 8 — Finish

When all components have:
- an open PR to `master`, and
- a consolidation report written,

summarize to the user:
- the list of PRs (with links),
- the list of consolidation reports (with paths),
- any proposed cross-session follow-ups (names + which branches they span).

## Key constraints

- **One grok agent per folder** during probing, launched in parallel in a single message.
- **One glm-5.2 planner per component**, each on its own branch named `<criteria>/<component-name>`.
- **Branch isolation**: a component's changes stay within its boundary list. The plan prompt forbids touching files outside the component.
- **Swarm only when >1 subtask**: single-subtask plans get a single grok agent.
- **One PR per component**, all targeting `master`. Never combine components.
- **Rolling consolidation**: the topmost glm-5.2 runs after each PR, not just at the end.
- **User gate**: no implementation (Step 5) starts until the user accepts that component's plan (Step 4).
- **Model slugs are fixed**: grok = `cursor-grok-4.5-high-fast`, glm = `glm-5.2-high`. Do not substitute.
- **Probe output is compressed**: file-path-first, line-attached, ≤300 tokens per folder. Probes that return prose are wasting context — re-prompt with the contract.

## Files in this skill

- [SKILL.md](SKILL.md) — this file.
- [probe-prompt.md](probe-prompt.md) — prompt template for grok-4.5 folder/layer probes.
- [plan-prompt.md](plan-prompt.md) — prompt template for glm-5.2 component planners.
- `consolidations/` — runtime output directory for topmost-agent overlap reports (one file per component PR).
