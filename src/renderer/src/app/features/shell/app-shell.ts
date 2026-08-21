import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet],
  template: '<router-outlet />',
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
export class AppShell {}
