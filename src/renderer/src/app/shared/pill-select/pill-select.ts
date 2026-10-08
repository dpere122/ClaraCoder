import { NgStyle } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

export interface PillSelectOption {
  id?: string;
  value?: string;
  label: string;
  group?: string;
  title?: string;
}

/** Pill trigger with a rounded menu. Native selects cannot theme the open list. */
@Component({
  selector: 'app-pill-select',
  imports: [NgStyle],
  templateUrl: './pill-select.html',
  styleUrl: './pill-select.css',
})
export class PillSelectComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly options = input<readonly object[]>([]);
  /** Property used as the option value. Defaults to ``id``, then ``value``. */
  readonly valueKey = input('id');
  readonly labelKey = input('label');
  readonly value = input('');
  readonly disabled = input(false);
  readonly ariaLabel = input('Select');
  /** Id placed on the trigger so an external label can point at it. */
  readonly controlId = input('');

  readonly valueChange = output<string>();

  protected readonly open = signal(false);
  protected readonly openUp = signal(false);
  protected readonly menuStyle = signal<Record<string, string>>({});
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  protected readonly selectedLabel = computed(() => {
    const id = this.value();
    const match = this.options().find((option) => this.optionId(option) === id);
    return match ? this.optionLabel(match) : id;
  });

  constructor() {
    // Show the menu in the top layer: a transformed or filtered ancestor (e.g. the animated
    // composer) would otherwise re-anchor `position: fixed` to itself and push the menu off-screen.
    effect(() => {
      const menu = this.menu()?.nativeElement;
      if (menu && typeof menu.showPopover === 'function' && !menu.matches(':popover-open')) {
        menu.showPopover();
      }
    });

    const onScroll = (event: Event): void => {
      if (!this.open()) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && this.host.nativeElement.contains(target)) {
        return;
      }
      this.open.set(false);
    };
    document.addEventListener('scroll', onScroll, true);
    this.destroyRef.onDestroy(() => document.removeEventListener('scroll', onScroll, true));
  }

  protected optionId(option: object): string {
    const row = option as Record<string, unknown>;
    const key = this.valueKey();
    const raw = row[key] ?? row['id'] ?? row['value'];
    return raw == null ? '' : String(raw);
  }

  protected optionLabel(option: object): string {
    const row = option as Record<string, unknown>;
    const raw = row[this.labelKey()];
    return typeof raw === 'string' && raw ? raw : this.optionId(option);
  }

  protected optionTitle(option: object): string | null {
    const title = (option as { title?: string }).title;
    return title?.trim() ? title : null;
  }

  protected groupHeading(index: number): string {
    const options = this.options();
    const group = (options[index] as { group?: string } | undefined)?.group?.trim() ?? '';
    if (!group) {
      return '';
    }
    const prev = index > 0 ? (options[index - 1] as { group?: string }).group?.trim() ?? '' : '';
    return group === prev ? '' : group;
  }

  protected toggle(event: Event): void {
    event.stopPropagation();
    if (this.disabled()) {
      return;
    }
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.placeMenu();
    this.open.set(true);
  }

  protected pick(id: string): void {
    this.open.set(false);
    if (id !== this.value()) {
      this.valueChange.emit(id);
    }
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) {
      return;
    }
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
  }

  @HostListener('window:resize')
  protected onResize(): void {
    if (this.open()) {
      this.placeMenu();
    }
  }

  private placeMenu(): void {
    const trigger = this.host.nativeElement.querySelector('.pill-select__trigger');
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    this.openUp.set(openUp);
    const width = Math.max(rect.width, 160);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const room = Math.max(120, Math.min(224, (openUp ? spaceAbove : spaceBelow) - 12));
    this.menuStyle.set(
      openUp
        ? {
            position: 'fixed',
            left: `${left}px`,
            width: `${width}px`,
            bottom: `${window.innerHeight - rect.top + 6}px`,
            top: 'auto',
            maxHeight: `${room}px`,
            zIndex: '10000',
          }
        : {
            position: 'fixed',
            left: `${left}px`,
            width: `${width}px`,
            top: `${rect.bottom + 6}px`,
            bottom: 'auto',
            maxHeight: `${room}px`,
            zIndex: '10000',
          },
    );
  }
}
