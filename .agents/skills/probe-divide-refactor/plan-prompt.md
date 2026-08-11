# Plan Prompt Template (glm-5.2)

Fill in the placeholders before spawning the planner `Task` subagent. One planner per component.

## How to use

Spawn one `Task` subagent per component with:

```
subagent_type: "generalPurpose"
model: "glm-5.2-high"
environment: "cloud"          # each planner gets its own worktree/branch
run_in_background: false
```

Pass the filled-in prompt below as the `prompt` argument. Each planner runs to
completion and returns its plan to the main agent, who surfaces it to the user
for accept/reject. On reject, `resume` the same planner with the user's feedback.

## Template

```
You are a planner agent in the probe-divide-refactor workflow. You will produce
a focused refactor plan for ONE component, on a dedicated branch, in plan mode.

COMPONENT_NAME: {COMPONENT_NAME}
CRITERIA: {CRITERIA}                 # hardening | optimization | efficiency | security | <user-named>
BRANCH_NAME: {BRANCH_NAME}           # exactly <criteria>/<component-name>, lowercase, hyphenated
BOUNDARY_LIST:                       # files/dirs this component may touch — do NOT write outside this list
{BOUNDARY_LIST}
PROBE_FINDINGS (from grok-4.5 probes for this component):
"""
{PROBE_FINDINGS}
"""
PURPOSE_STATEMENT (verbatim, from the user):
"""
{USER_PURPOSE_STATEMENT}
"""

STEPS YOU MUST PERFORM, IN ORDER:

1. Create the branch named exactly {BRANCH_NAME} from master:
   `git checkout master && git pull && git checkout -b {BRANCH_NAME}`
   If the branch already exists, re-use it.

2. Enter plan mode. Do not edit code yet. Produce a plan that:
   a. Is grounded in the PURPOSE_STATEMENT and CRITERIA.
   b. Maps each PROBE_FINDINGS item to a concrete change.
   c. Lists every file you will modify, with the specific change per file.
   d. Stays strictly within BOUNDARY_LIST. If a finding requires touching a file
      outside the boundary, mark it as OUT-OF-SCOPE and leave it for the
      topmost consolidation agent — do not include it in this plan.
   e. Splits the work into independent subtasks when possible (each subtask
      becomes a separate grok-4.5 implementer in the next step). A single
      subtask is fine when the work is tightly coupled.
   f. Names a reviewer type: "security-review" if CRITERIA is security;
      "bugbot" if CRITERIA is hardening/optimization/efficiency; otherwise
      "generalPurpose" grok-4.5 reviewer.

3. Return the plan in this exact shape:

   PLAN: {COMPONENT_NAME}
   branch: {BRANCH_NAME}
   criteria: {CRITERIA}
   boundary: <one-line summary of BOUNDARY_LIST>

   subtasks:
   - subtask-1-name
     files:
     - path/to/file.ts — <change ≤15 words>
     reviewer: <reviewer type>
   - subtask-2-name
     files:
     - path/to/other.ts — <change ≤15 words>
     reviewer: <reviewer type>

   out-of-scope:
   - <finding or file left for consolidation, with reason>

   risk: <one line on the biggest risk of this plan>

CONSTRAINTS:

- Do not edit code. You are planning only. The grok-4.5 swarm will implement
  after the user accepts your plan.
- Do not touch files outside BOUNDARY_LIST. This is enforced — out-of-scope
  items go in the `out-of-scope` section, not in subtasks.
- Keep the plan tight. If a subtask's file list exceeds 5 files, split it.
- If PROBE_FINDINGS is empty or "No match.", return:
    PLAN: {COMPONENT_NAME}
    status: nothing-to-do
  and stop.
```

## Placeholders

| Placeholder | Source |
|---|---|
| `COMPONENT_NAME` | From Step 3 of the skill (e.g. `auth-middleware`). |
| `CRITERIA` | From Step 1 of the skill. |
| `BRANCH_NAME` | `<criteria>/<component-name>`, lowercase, hyphenated. |
| `BOUNDARY_LIST` | The component's boundary list from Step 3. One path per line. |
| `PROBE_FINDINGS` | The deduped probe findings assigned to this component in Step 3. Paste verbatim. |
| `USER_PURPOSE_STATEMENT` | The user's verbatim purpose statement. Do not paraphrase. |

## Notes for the main agent

- One planner per component. Spawn planners sequentially or in parallel as you prefer, but each must be on its own branch.
- Surface each returned plan to the user for accept/reject before Step 5 (implement).
- On reject, `resume` the same planner agent with the user's feedback; do not spawn a fresh planner.
- On accept, proceed to Step 5 of the skill (grok-4.5 swarm) on that branch.
- A planner that returns `status: nothing-to-do` is dropped — no branch, no PR, no consolidation.
