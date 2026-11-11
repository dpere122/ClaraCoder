import './monaco-environment';
import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/features/shell/app';
import { AppShell } from './app/features/shell/app-shell';
import { provideRouter, withHashLocation, type Routes } from '@angular/router';
import { builtInThemeForMode } from '@shared/theme';
import { applyBuiltInThemeSync, browserModeStorage, readCachedThemeMode } from './app/core/theme/theme-dom';

// A hash-only navigation resolves against <base>. In packaged file:// windows, the
// directory base would drop index.html from the address, making a renderer reload fail.
// A filename base keeps relative assets in the same directory and preserves the entry file.
if (window.location.protocol === 'file:' && /\/index\.html$/i.test(window.location.pathname)) {
  document.querySelector('base')?.setAttribute('href', './index.html');
}

// Paint a built-in theme before Angular boots so the first frame is never unstyled. The mode
// is the one painted last session, so light-theme users do not get a dark flash; the
// ThemeEngineService takes over (persisted selection, library, live preview) once running.
applyBuiltInThemeSync(document, builtInThemeForMode(readCachedThemeMode(browserModeStorage())).id);

// Each secondary window is its own BrowserWindow on its own route, so it loads its component
// as a lazy chunk. That keeps the main window's initial bundle to the workspace UI.
const routes: Routes = [
  { path: '', component: App, data: { tutorialWindow: 'home' } },
  {
    path: 'settings',
    loadComponent: () => import('./app/features/settings/settings/settings').then((m) => m.Settings),
    data: { tutorialWindow: 'settings' },
  },
  {
    path: 'health',
    loadComponent: () => import('./app/features/health/health-monitor/health-monitor').then((m) => m.HealthMonitor),
  },
  {
    path: 'dependencies',
    loadComponent: () => import('./app/features/dependencies/dependencies/dependencies').then((m) => m.Dependencies),
    data: { tutorialWindow: 'dependencies' },
  },
  {
    path: 'updater',
    loadComponent: () => import('./app/features/updater/updater/updater').then((m) => m.Updater),
  },
];

// Dev builds in a plain browser tab: attach to the main process if `npm run dev:bridge` handed
// this tab a token. Lazy so production bundles never load it; Electron windows have a preload.
const browserBridgeReady =
  isDevMode() && !window.electronAPI
    ? import('./app/core/dev-bridge/browser-bridge')
        .then((bridge) => bridge.installBrowserBridgeFromLocation())
        .catch((err) => console.error('[BrowserBridge] Failed to install:', err))
    : Promise.resolve();

browserBridgeReady
  .then(() =>
    bootstrapApplication(AppShell, {
      ...appConfig,
      providers: [
        ...(appConfig.providers ?? []),
        provideRouter(routes, withHashLocation()),
      ],
    }),
  )
  .catch((err) => console.error(err));
