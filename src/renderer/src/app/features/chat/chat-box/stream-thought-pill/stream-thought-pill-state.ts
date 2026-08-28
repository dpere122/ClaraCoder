import type { ToolTrailPillState } from '@shared/index';

export function thoughtPillLabel(live: boolean, active: boolean): string {
  return live && active ? 'Thinking…' : 'Thought';
}

export function thoughtPillState(live: boolean, active: boolean): ToolTrailPillState {
  return live && active ? 'running' : 'complete';
}

/** User override wins; otherwise expand only while this thought is the latest live event. */
export function resolveThoughtPillExpanded(
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
export function isThoughtStreamingPreview(
  live: boolean,
  active: boolean,
  userOverride: boolean | null,
): boolean {
  if (userOverride === false) {
    return false;
  }
  return live && active;
}
