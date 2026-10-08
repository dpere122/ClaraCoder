import './monaco-environment';
import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/features/shell/app';
import { AppShell } from './app/features/shell/app-shell';
import { Settings } from './app/features/settings/settings/settings';
import { HealthMonitor } from './app/features/health/health-monitor/health-monitor';
import { Dependencies } from './app/features/dependencies/dependencies/dependencies';
import { provideRouter, withHashLocation } from '@angular/router';
import { builtInThemeForMode } from '@shared/theme';
import { applyBuiltInThemeSync, browserModeStorage, readCachedThemeMode } from './app/core/theme/theme-dom';

// Paint a built-in theme before Angular boots so the first frame is never unstyled. The mode
// is the one painted last session, so light-theme users do not get a dark flash; the
// ThemeEngineService takes over (persisted selection, library, live preview) once running.
applyBuiltInThemeSync(document, builtInThemeForMode(readCachedThemeMode(browserModeStorage())).id);

const routes = [
  { path: '', component: App },
  { path: 'settings', component: Settings },
  { path: 'health', component: HealthMonitor },
  { path: 'dependencies', component: Dependencies },
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
