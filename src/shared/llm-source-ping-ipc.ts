/** Result of pinging the selected chat source; ``error`` is shown in the composer as written. */
export type LlmSourcePingResult = { ok: true } | { ok: false; error: string };
