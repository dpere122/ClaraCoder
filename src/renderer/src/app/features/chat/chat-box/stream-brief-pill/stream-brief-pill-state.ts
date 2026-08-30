import type { ToolTrailPillState } from '@shared/index';

export function briefPillLabel(_live: boolean, _active: boolean): string {
  return 'reasoning';
}

export function briefPillState(live: boolean, active: boolean): ToolTrailPillState {
  return live && active ? 'running' : 'complete';
}

/** User override wins; otherwise expand only while this brief is the latest live event. */
export function resolveBriefPillExpanded(
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
export function isBriefStreamingPreview(
  live: boolean,
  active: boolean,
  userOverride: boolean | null,
): boolean {
  if (userOverride === false) {
    return false;
  }
  return live && active;
}
