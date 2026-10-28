/**
 * Whether this renderer is a dev browser-bridge tab rather than an Electron window. Kept apart
 * from `browser-bridge.ts` so app code can ask without pulling the bridge into the bundle.
 */
let browserBridgeTab = false;

/** Called by the bridge once it has installed `electronAPI` in this tab. */
export function markBrowserBridgeTab(): void {
  browserBridgeTab = true;
}

export function isBrowserBridgeTab(): boolean {
  return browserBridgeTab;
}
