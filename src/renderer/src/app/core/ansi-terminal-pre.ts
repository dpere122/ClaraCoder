import {
  Component,
  ViewEncapsulation,
  computed,
  inject,
  input,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ansiTerminalOutputHtml } from './ansi-terminal-output';

@Component({
  selector: 'app-ansi-terminal-pre',
  standalone: true,
  template: `<pre [class]="preClass()" [innerHTML]="htmlText()"></pre>`,
  encapsulation: ViewEncapsulation.None,
})
export class AnsiTerminalPreComponent {
  private readonly sanitizer = inject(DomSanitizer);

  readonly text = input.required<string>();
  readonly preClass = input('output-pre terminal-output terminal-output-stdout terminal-ansi');

  readonly htmlText = computed(() =>
    this.sanitizer.bypassSecurityTrustHtml(ansiTerminalOutputHtml(this.text())),
  );
}
