# `stream-payload.ts`

Canonical parser for the agent SSE/stream wire protocol used by Clara Coder.

The backend (Python) emits streaming events as JSON lines. The renderer (and any
other TypeScript consumer) needs a single, well-typed entry point that turns
those raw JSON strings into a discriminated union the UI can switch on. That
entry point is [`parseAgentStreamPayload`](#parseagentstreampayload).

This module is intentionally side-effect free and dependency-light: it only
imports the typed payload shapes from `./types/*` and a single normalizer
(`normalizePlanConfirmFilesToChange`). It is safe to use from the main process,
the renderer, and tests.

---

## Contents

- [Exports](#exports)
  - [`ParsedAgentStreamPayload`](#parsedagentstreampayload)
  - [`parseAgentStreamPayload`](#parseagentstreampayload)
- [Internal helpers](#internal-helpers)
- [Wire protocol reference](#wire-protocol-reference)
- [Design notes](#design-notes)
- [Adding a new event type](#adding-a-new-event-type)

---

## Exports

### `ParsedAgentStreamPayload`

A discriminated union (discriminant: `type`) describing every event the agent
stream can produce. Consumers should `switch (payload.type)` and let TypeScript
narrow the variant.

| `type` | Field shape | Source / meaning |
| --- | --- | --- |
| `chunk` | `delta: string`, `streamTag?: string` | Free-form assistant text. `streamTag` multiplexes sub-streams (e.g. `agent`, `reasoning`). |
| `tool_read_chunk` | `delta: string`, `statusId?: string` | Preview text emitted by a read-only workspace tool while it runs. `statusId` names the tool status row the text belongs to, so parallel reads each fill their own pill. |
| `tool_exec_chunk` | `delta: string`, `streamTag?: string`, `label?: string` | Incremental stdout/stderr from a tool execution stream. |
| `background_command_open` | `commandId`, `commandText`, `cwdLabel`, `label`, `streamTag` (all `string`) | A long-running/background command was opened; subsequent `tool_exec_chunk` events with the same `streamTag` belong to it. |
| `tool_exec_complete` | `streamTag?`, `label?`, `exitCode?: number \| null`, `outputExcerpt?`, `outcome?: 'passed' \| 'failed'` | A tool execution stream finished. `outputExcerpt` is a tail/full replay used when live chunks were empty or incomplete (pytest/overlay). `outcome`, when set, drives the terminal badge instead of the raw exit code (watch-mode smoke tests). |
| `token_usage` | `inputTokens: number`, `outputTokens?`, `totalTokens?` | Token accounting for a completed LLM request. `inputTokens` maps to OpenAI `prompt_tokens` / LangChain `input_tokens`. |
| `status` | `status: LlmStatusPayload` | LLM/agent status update (state, label, detail, source, optional `streamTag` and `agentRole`). A finished tool status can also carry `toolBatch`, `toolDiff` (the unified diff an edit wrote) and `durationMs` (how long the call ran). |
| `accept_command` | `acceptCommand: AcceptCommandPayload` | HITL prompt to accept a shell command before running. |
| `delete_confirm` | `deleteConfirm: DeleteConfirmPayload` | HITL prompt to confirm a deletion. |
| `planner_progress` | `planner: PlannerProgress` | Planner step progress. |
| `build_plan_open` | `buildPlanOpen: BuildPlanOpenPayload` | Start of a streamed build-plan file. |
| `build_plan_chunk` | `buildPlanChunk: { relativePath: string; content: string }` | A chunk of build-plan content for `relativePath`. |
| `build_plan_stream_end` | `buildPlanStreamEnd: { relativePath: string }` | End of a streamed build-plan file. |
| `plan_confirm` | `planConfirm: PlanConfirmPayload` | HITL prompt to confirm a proposed plan. `filesToChange` is normalized via `normalizePlanConfirmFilesToChange`. |
| `agent_question` | `agentQuestion: AgentQuestionPayload` | Agent is asking the user a structured question. |
| `theme_proposal` | `themeProposal: ThemeProposalPayload` | Agent-authored app theme (`propose_theme` tool). Non-blocking: the card's Preview / Save / Dismiss resolve through Electron IPC, never back to Python. Gated by `isThemeProposalPayload`. |
| `final_text` | `text: string` | Terminal, non-streamed text to append after the stream closes. |
| `clear_primary_stream` | _(none)_ | Instructs the UI to clear the primary stream buffer. |
| `promote_primary_to_nudge` | _(none)_ | Retags live primary (`agent`) prose as a nudge preview because the graph is jumping back to the model. |
| `context_compressed` | `tokensBefore`, `tokensAfter`, `toolMessagesCompacted`, `toolRoundsDropped` (all `number`) | Context window compaction event. |
| `subagent_started` | `conversationId`, `name`, `task`, `parentConversationId?`, `parentTurnId?`, `statusId?`, `background?` | The main agent's `spawn_subagent` call started a sub-agent. Sent before any of its events. Main creates the sub-agent's conversation row from it. |
| `subagent_event` | `conversationId`, `payload: ParsedAgentStreamPayload \| null` | One event of a sub-agent's own stream, including its `file_journal` rows (journaled under the parent turn). `payload` is `null` (dropped) when the wrapped event is invalid or itself a `subagent_*` event. |
| `subagent_finished` | `conversationId`, `outcome: 'completed' \| 'aborted' \| 'error'` | The sub-agent's turn ended (sent once, after all its events). Unknown outcomes read as `error`. |
| `subagent_results_ready` | `parentConversationId`, `names: string[]` | Sub-agent reports wait for a parent with no turn running; the renderer starts one (`continue_with_subagent_results`) to hand them to the main agent. |

The `subagent_*` events arrive on the sub-agent channel (`GET /subagents/events`, consumed by
`src/main/ipc/handlers/subagent-events.ts`), never on a `/chat/stream`: a sub-agent outlives the
turn that spawned it. A `status` for a `spawn_subagent` pill can carry
`subagent: { conversationId, name }` (the sub-agent it runs).

> Note: `ParsedAgentStreamPayload` is the only type re-exported for consumers.
> The internal `RawAgentStreamPayload` shape (snake_case wire fields) is not
> exported.

---

### `parseAgentStreamPayload`

```ts
function parseAgentStreamPayload(payload: string): ParsedAgentStreamPayload
```

Parse one JSON event line from the agent stream into a typed
`ParsedAgentStreamPayload`.

#### Behavior

1. Attempts `JSON.parse(payload)`.
2. Dispatches on `parsed.type` (snake_case wire string) and validates the
   minimum required fields for that event.
3. For events that pass validation, returns the corresponding
   `ParsedAgentStreamPayload` variant with fields coerced to camelCase and
   normalized (strings trimmed, numbers floored to non-negative ints, etc.).
4. For events that fail validation, **falls through** to step 5.
5. If `JSON.parse` throws, or no branch matched, the payload is treated as
   plain text and returned as:

   ```ts
   { type: 'chunk', delta: payload }
   ```

   This guarantees the function never throws and always returns a value the
   UI can render — malformed wire data degrades to visible text rather than
   crashing the stream.

#### Field coercion rules

- **Strings** are trimmed via [`optionalTrimmedString`](#optionaltrimmedstring);
  empty/whitespace strings become `undefined` so consumers can rely on
  truthy checks.
- **Integers** are validated as finite, non-negative numbers and floored via
  [`optionalNonNegativeInt`](#optionalnonnegativeint).
- **`status`** applies defaults: `detail ?? ''`, `state ?? 'running'`,
  `source ?? 'agent'`. `agent_role` is only kept when it is exactly
  `'manager'` or `'worker'`; any other value is dropped. `diff` becomes
  `toolDiff` when it is a non-empty string, and `duration_ms` becomes
  `durationMs` when it is a finite number of at least 0.
- **`durationMs`** is the time the call spent working, never time spent
  waiting for the user. A call that needs approval finishes first with a
  `Pending user confirmation…` detail and no `durationMs`. Once the card is
  answered, a second finished status with the same `id` carries the result
  (or the cancel note) and the time before the card plus the approved run.
  A cancelled or denied call ran nothing, so it has no `durationMs`.
- **`plan_confirm`** runs `normalizePlanConfirmFilesToChange` over
  `filesToChange` so the renderer always sees a consistent shape regardless
  of which legacy form the backend emitted.
- **`build_plan_chunk` / `build_plan_stream_end`** require `relativePath`
  (and `content` for chunks) to be strings; otherwise the event is dropped
  and falls through to the plain-text `chunk` fallback.
- **`context_compressed`** accepts both camelCase
  (`tokensBefore`, `tokensAfter`, `toolMessagesCompacted`,
  `toolRoundsDropped`) and snake_case (`tokens_before`, …) forms, for
  backwards compatibility. `toolMessagesCompacted` and `toolRoundsDropped`
  default to `0` when absent; `tokensBefore`/`tokensAfter` are required.

#### Example

```ts
import { parseAgentStreamPayload } from '@/shared/stream-payload';

for (const line of sseLines) {
  const event = parseAgentStreamPayload(line);
  switch (event.type) {
    case 'chunk':
      appendAssistantText(event.delta, event.streamTag);
      break;
    case 'tool_exec_complete':
      markToolDone(event.streamTag, event.exitCode ?? 0, event.outcome);
      break;
    case 'context_compressed':
      telemetry.contextCompressed(event.tokensBefore, event.tokensAfter);
      break;
    // …
    default:
      assertNever(event);
  }
}
```

---

## Internal helpers

### `optionalTrimmedString`

```ts
function optionalTrimmedString(value: unknown): string | undefined
```

Returns the trimmed string if `value` is a non-empty string after trimming,
otherwise `undefined`. Used for optional string fields where an empty value
should be absent from the parsed payload.

### `optionalNonNegativeInt`

```ts
function optionalNonNegativeInt(value: unknown): number | undefined
```

Returns `Math.floor(value)` when `value` is a finite, non-negative number,
otherwise `undefined`. Used for token counts and compaction counters.

### `RawAgentStreamPayload`

The internal `typeof JSON.parse(...)` cast. Mirrors the snake_case wire
schema with everything typed as `unknown` (except `type` and a few nested
objects) so each branch is forced to validate before narrowing. Not
exported.

---

## Wire protocol reference

The backend emits one JSON object per event with a `type` field. The table
below maps wire `type` → parsed `type` (they are identical except where
noted) and lists the wire fields each branch reads.

| Wire `type` | Parsed `type` | Wire fields read |
| --- | --- | --- |
| `chunk` | `chunk` | `delta`, `stream_tag` |
| `tool_read_chunk` | `tool_read_chunk` | `delta`, `status_id` |
| `tool_exec_chunk` | `tool_exec_chunk` | `delta`, `stream_tag`, `label` |
| `tool_exec_complete` | `tool_exec_complete` | `stream_tag`, `label`, `exit_code`, `output_excerpt`, `outcome` |
| `background_command_open` | `background_command_open` | `command_id`, `command_text`, `cwd_label`, `label`, `stream_tag` |
| `token_usage` | `token_usage` | `input_tokens`, `output_tokens`, `total_tokens` |
| `status` | `status` | `status.{id,label,detail,state,source,stream_tag,agent_role,tool_batch,diff,duration_ms,subagent.{conversation_id,name}}` |
| `accept_command` | `accept_command` | `acceptCommand` (object) |
| `delete_confirm` | `delete_confirm` | `deleteConfirm` (object) |
| `planner_progress` | `planner_progress` | `planner` (object) |
| `build_plan_open` | `build_plan_open` | `buildPlanOpen` (object) |
| `build_plan_chunk` | `build_plan_chunk` | `buildPlanChunk.{relativePath, content}` |
| `build_plan_stream_end` | `build_plan_stream_end` | `buildPlanStreamEnd.relativePath` |
| `plan_confirm` | `plan_confirm` | `planConfirm` (object, `filesToChange` normalized) |
| `agent_question` | `agent_question` | `agentQuestion` (object) |
| `theme_proposal` | `theme_proposal` | `themeProposal` (object: `version: 1`, `requestId`, `title`, `summary`, `theme`, `warnings?`) |
| `final_text` | `final_text` | `text` |
| `clear_primary_stream` | `clear_primary_stream` | _(none)_ |
| `promote_primary_to_nudge` | `promote_primary_to_nudge` | _(none)_ |
| `context_compressed` | `context_compressed` | `tokens_before`/`tokensBefore`, `tokens_after`/`tokensAfter`, `tool_messages_compacted`/`toolMessagesCompacted`, `tool_rounds_dropped`/`toolRoundsDropped` |
| `subagent_started` | `subagent_started` | `conversation_id`, `parent_conversation_id`, `parent_turn_id`, `name`, `task`, `status_id`, `background` |
| `subagent_event` | `subagent_event` | `conversation_id`, `payload` (object, parsed with `parseAgentStreamValue`) |
| `subagent_finished` | `subagent_finished` | `conversation_id`, `outcome` |
| `subagent_results_ready` | `subagent_results_ready` | `parent_conversation_id`, `names` |

> The wire protocol is a mix of snake_case (top-level scalar fields) and
> camelCase (nested object payloads), reflecting historical emitter
> changes. The parser normalizes everything to camelCase on the way out.

---

## Design notes

- **Never throws.** Any parse or validation failure degrades to a
  `{ type: 'chunk', delta: payload }` text chunk. This is deliberate: a
  malformed line should never kill the stream loop.
- **Validation by presence.** Each branch checks `parsed.type === '<name>'`
  plus the minimum required nested object/string fields. Branches that need
  stricter shape (e.g. `build_plan_chunk`) re-cast and re-check before
  emitting; otherwise they fall through to the plain-text fallback.
- **Order matters.** More specific branches (e.g. `tool_exec_chunk`) are
  checked before the generic `chunk` branch so they are not shadowed.
- **No streaming/state.** The parser is pure: one string in, one typed
  object out. Buffering, re-assembly, and SSE frame splitting live in the
  caller.
- **Backwards compatible.** `context_compressed` accepts both naming
  conventions; `status` accepts a legacy `agent_role` enum and drops
  unknown values; `plan_confirm` runs a normalizer. New consumers can rely
  on the documented camelCase shape even when reading old saved
  conversations.

---

## Adding a new event type

1. Define the payload shape in `./types/<event>.ts` and export it from
   `./types/index.ts` if a barrel exists.
2. Add a new variant to `ParsedAgentStreamPayload` with a unique `type`
   literal.
3. Add a branch in `parseAgentStreamPayload`:
   - Check `parsed.type === '<wire_type>'`.
   - Validate the minimum required fields.
   - Coerce via `optionalTrimmedString` / `optionalNonNegativeInt`.
   - Return the new variant, or fall through (do not return `undefined`).
4. Add a row to the [Wire protocol reference](#wire-protocol-reference)
   table above.
5. Update consumers (`switch` statements in the renderer stream loop, any
   saved-conversation replay code, and tests in
   `python/tests/test_prompt_blocks_edit_semantics.ts`-style specs).
