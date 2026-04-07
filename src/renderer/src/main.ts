import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/features/shell/app';
import { AppShell } from './app/features/shell/app-shell';
import { Settings } from './app/features/settings/settings/settings';
import { HealthMonitor } from './app/features/health/health-monitor/health-monitor';
import { provideRouter, withHashLocation } from '@angular/router';

const routes = [
  { path: '', component: App },
  { path: 'settings', component: Settings },
  { path: 'health', component: HealthMonitor },
];

bootstrapApplication(AppShell, {
  ...appConfig,
  providers: [
    ...(appConfig.providers ?? []),
    provideRouter(routes, withHashLocation()),
  ],
})
  .catch((err) => console.error(err));
