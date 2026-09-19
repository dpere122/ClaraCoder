import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** Packaged + dev: `build/icon.ico` (Windows) or `build/icon.png` at repo root. */
export function resolveAppIconPath(): string | undefined {
  const files = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png'];
  const roots = [
    path.join(process.cwd(), 'build'),
    path.join(__dirname, '..', '..', '..', 'build'),
    path.join(app.getAppPath(), 'build'),
  ];
  for (const file of files) {
    for (const root of roots) {
      const candidate = path.join(root, file);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}
