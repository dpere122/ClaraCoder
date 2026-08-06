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
      box-shadow: inset 0 0 0 1px var(--t-border-subtle);
    }
  `,
})
export class AppShell {}
