import { Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import type { TutorialWindow } from '@shared/types/tutorial';
import { ThemeEngineService } from '../../core/theme/theme-engine.service';
import { TutorialCoordinator } from '../tutorial/tutorial-coordinator';
import { TutorialOverlayComponent } from '../tutorial/tutorial-overlay/tutorial-overlay';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, TutorialOverlayComponent],
  template: '<router-outlet /><app-tutorial-overlay />',
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 100%;
      overflow: hidden;
      box-sizing: border-box;
      /* Frameless windows have no OS chrome; this theme-colored rim is the
         silhouette against the desktop (and against overlapping Clara windows). */
      border: 2px solid color-mix(in srgb, var(--t-primary) 72%, transparent);
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--t-bg-deep) 70%, transparent),
        inset 0 0 22px color-mix(in srgb, var(--t-primary) 16%, transparent);
    }
  `,
})
export class AppShell {
  /** Every window (main, settings, health, dependencies) boots through this shell. */
  private readonly themeEngine = inject(ThemeEngineService);
  private readonly router = inject(Router);
  private readonly tutorial = inject(TutorialCoordinator);

  constructor() {
    this.themeEngine.start();
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const role: unknown = this.router.routerState.snapshot.root.firstChild?.data['tutorialWindow'];
      this.tutorial.enterWindow(role === 'home' || role === 'dependencies' || role === 'settings' ? role as TutorialWindow : null);
    });
  }
}
