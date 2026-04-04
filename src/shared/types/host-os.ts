/** OS summary sent to the Python backend with runtime config. */
export interface HostOsInfo {
  platform: string;
  release: string;
  arch: string;
  version: string;
  label: string;
}
