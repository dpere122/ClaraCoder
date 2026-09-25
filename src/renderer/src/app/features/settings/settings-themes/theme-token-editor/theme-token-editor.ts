import { Component, ViewEncapsulation, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CODE_FONT_FAMILY_OPTIONS, UI_FONT_FAMILY_OPTIONS } from '@shared/index';
import { cssColorToHex, type ThemeTokenDef } from '@shared/theme';

export interface ThemeTokenChange {
  name: string;
  /** `null` clears the explicit value so the inherited one shows through. */
  value: string | null;
}

/**
 * Grid of token controls. Each row shows the effective value (explicit or inherited) with a
 * control chosen by token kind: color picker + text for colors, text + font suggestions for
 * fonts, plain text otherwise. A Reset link appears when the value is explicitly set.
 */
@Component({
  selector: 'app-theme-token-editor',
  imports: [FormsModule],
  templateUrl: './theme-token-editor.html',
  encapsulation: ViewEncapsulation.None,
})
export class ThemeTokenEditor {
  readonly tokens = input.required<readonly ThemeTokenDef[]>();
  /** Explicit values in the document layer being edited. */
  readonly values = input.required<Record<string, string>>();
  /** Values the tokens resolve to when not explicitly set. */
  readonly inherited = input<Record<string, string>>({});
  readonly readOnly = input(false);
  /** Compact rows (used inside group panels). */
  readonly dense = input(false);
  readonly tokenChange = output<ThemeTokenChange>();

  protected readonly fontStacks = computed(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const opt of [...UI_FONT_FAMILY_OPTIONS, ...CODE_FONT_FAMILY_OPTIONS]) {
      if (opt.stack && !seen.has(opt.stack)) {
        seen.add(opt.stack);
        out.push(opt.stack);
      }
    }
    return out;
  });

  protected isSet(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.values(), name);
  }

  protected effective(name: string): string {
    return this.values()[name] ?? this.inherited()[name] ?? '';
  }

  protected inheritedPlaceholder(name: string): string {
    return this.inherited()[name] ?? '';
  }

  /** `#rrggbb` for `<input type="color">`; falls back to black for unparseable values. */
  protected colorInputValue(name: string): string {
    const hex = cssColorToHex(this.effective(name));
    return hex ? hex.slice(0, 7) : '#000000';
  }

  /** Swatch background: the CSS value itself (var()/color-mix resolve through the live cascade). */
  protected swatchStyle(name: string): string {
    const value = this.effective(name);
    return value ? value : 'transparent';
  }

  protected onColorPick(name: string, hex: string): void {
    if (this.readOnly()) {
      return;
    }
    this.tokenChange.emit({ name, value: hex });
  }

  protected onTextChange(name: string, text: string): void {
    if (this.readOnly()) {
      return;
    }
    const trimmed = text.trim();
    this.tokenChange.emit({ name, value: trimmed ? trimmed : null });
  }

  protected reset(name: string): void {
    if (this.readOnly()) {
      return;
    }
    this.tokenChange.emit({ name, value: null });
  }

  protected inputId(name: string): string {
    return `tte-${name.replace(/[^a-z0-9-]/gi, '')}`;
  }
}
