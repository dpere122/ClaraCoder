export type AuxiliaryPanelMode = 'collapsed' | 'preview' | 'expanded';

/** True when the panel should use live peek/expand cycling (stream still updating). */
export function auxiliaryPanelStreamingPeek(live: boolean): boolean {
  return live;
}

/** Default mode when the panel mounts (live → preview, persisted → collapsed). */
export function initialAuxiliaryPanelMode(live: boolean): AuxiliaryPanelMode {
  return live ? 'preview' : 'collapsed';
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
export function toggleAuxiliaryPanelMode(mode: AuxiliaryPanelMode, live: boolean): AuxiliaryPanelMode {
  if (auxiliaryPanelStreamingPeek(live)) {
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
