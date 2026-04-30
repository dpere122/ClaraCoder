import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** Packaged + dev: `build/icon.png` at repo root (also listed in `electron-builder.yml` `files`). */
export function resolveAppIconPath(): string | undefined {
  const file = 'icon.png';
  const candidates = [
    path.join(process.cwd(), 'build', file),
    path.join(__dirname, '..', '..', '..', 'build', file),
    path.join(app.getAppPath(), 'build', file),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
