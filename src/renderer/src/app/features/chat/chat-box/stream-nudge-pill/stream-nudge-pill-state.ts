import type { ToolTrailPillState } from '@shared/index';

export function nudgePillLabel(_live: boolean, _active: boolean): string {
  return 'nudge';
}

export function nudgePillState(live: boolean, active: boolean): ToolTrailPillState {
  return live && active ? 'running' : 'complete';
}

/** User override wins; otherwise expand only while this nudge is the latest live event. */
export function resolveNudgePillExpanded(
  live: boolean,
  active: boolean,
  userOverride: boolean | null,
): boolean {
  if (userOverride !== null) {
    return userOverride;
  }
  return live && active;
}

/** Live streaming preview pane; user collapse hides it in favor of the chip. */
export function isNudgeStreamingPreview(
  live: boolean,
  active: boolean,
  userOverride: boolean | null,
): boolean {
  if (userOverride === false) {
    return false;
  }
  return live && active;
}
