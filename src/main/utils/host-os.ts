import type { HostOsInfo } from '../../shared';

/**
 * Builds a human-readable OS label for the Python backend (`/runtime-config` host field).
 */
export function getHostOsInfo(): HostOsInfo {
  const os = require('os');
  const platform = process.platform;
  const release = os.release();
  const arch = os.arch();
  const version = typeof os.version === 'function' ? os.version() : release;

  let label = 'Unknown OS';
  if (platform === 'win32') {
    label = `Windows (${version})`;
  } else if (platform === 'darwin') {
    label = `macOS (${release})`;
  } else if (platform === 'linux') {
    label = `Linux (${release})`;
  } else {
    label = `${platform} (${release})`;
  }

  return { platform, release, arch, version, label };
}
