import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/features/shell/app';
import { AppShell } from './app/features/shell/app-shell';
import { Settings } from './app/features/settings/settings/settings';
import { provideRouter, withHashLocation } from '@angular/router';

const routes = [
  { path: '', component: App },
  { path: 'settings', component: Settings },
];

bootstrapApplication(AppShell, {
  ...appConfig,
  providers: [
    provideRouter(routes, withHashLocation()),
  ]
})
  .catch((err) => console.error(err));
