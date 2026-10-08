/**
 * The slice of `ipcRenderer` the preload API modules use. Electron's `ipcRenderer` satisfies it;
 * the dev browser bridge (`CLARA_BROWSER_BRIDGE=1`) supplies an HTTP-backed stand-in so a plain
 * browser tab gets the exact same `electronAPI` surface.
 */
export interface PreloadIpc {
  invoke(channel: string, ...args: any[]): Promise<any>;
  send(channel: string, ...args: any[]): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
}
