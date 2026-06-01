export type AuxiliaryPanelMode = 'collapsed' | 'preview' | 'expanded';

/** True when the panel should use live peek/expand cycling (tool stream still updating). */
export function auxiliaryPanelStreamingPeek(live: boolean, planPanelVisible = false): boolean {
  return live && !planPanelVisible;
}

/** Default mode when the panel mounts (live → preview, persisted → collapsed). */
export function initialAuxiliaryPanelMode(live: boolean, planPanelVisible = false): AuxiliaryPanelMode {
  if (planPanelVisible) {
    return 'collapsed';
  }
  return live ? 'preview' : 'collapsed';
}

/** When the plan checklist appears, tuck the tool stream away unless already fully expanded. */
export function transitionAuxiliaryPanelModeOnPlanVisibleChange(
  mode: AuxiliaryPanelMode,
  wasPlanVisible: boolean,
  isPlanVisible: boolean,
): AuxiliaryPanelMode {
  if (wasPlanVisible === isPlanVisible) {
    return mode;
  }
  if (isPlanVisible) {
    return mode === 'expanded' ? 'expanded' : 'collapsed';
  }
  return mode === 'collapsed' ? 'preview' : mode;
}

/** Apply live-phase transitions when `live` changes after mount. */
export function transitionAuxiliaryPanelModeOnLiveChange(
  mode: AuxiliaryPanelMode,
  wasLive: boolean,
  isLive: boolean,
): AuxiliaryPanelMode {
  if (wasLive === isLive) {
    return mode;
  }
  if (isLive) {
    return mode === 'collapsed' ? 'preview' : mode;
  }
  return mode === 'preview' ? 'collapsed' : mode;
}

/** Resolve mode on mount or when `live` flips. */
export function resolveAuxiliaryPanelModeForLive(
  current: AuxiliaryPanelMode,
  isLive: boolean,
  prevLive: boolean | undefined,
): AuxiliaryPanelMode {
  if (prevLive === undefined) {
    return initialAuxiliaryPanelMode(isLive);
  }
  return transitionAuxiliaryPanelModeOnLiveChange(current, prevLive, isLive);
}

/** Header toggle: preview ↔ expanded while streaming; collapsed ↔ expanded otherwise. */
export function toggleAuxiliaryPanelMode(
  mode: AuxiliaryPanelMode,
  live: boolean,
  planPanelVisible = false,
): AuxiliaryPanelMode {
  if (auxiliaryPanelStreamingPeek(live, planPanelVisible)) {
    return mode === 'expanded' ? 'preview' : 'expanded';
  }
  return mode === 'expanded' ? 'collapsed' : 'expanded';
}

export function auxiliaryPanelContentVisible(mode: AuxiliaryPanelMode): boolean {
  return mode !== 'collapsed';
}

export function auxiliaryPanelShouldAutoScrollPreview(mode: AuxiliaryPanelMode): boolean {
  return mode === 'preview';
}
