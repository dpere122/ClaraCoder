/** Root Angular providers for the renderer (browser error hooks; routing added in `main.ts`). */
import { ApplicationConfig, importProvidersFrom, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { NgxSpinnerModule } from 'ngx-spinner';
import { lucideAppProviders } from './lucide-setup';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAnimations(),
    importProvidersFrom(NgxSpinnerModule),
    ...lucideAppProviders,
  ],
};
