import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PillSelectComponent } from './pill-select';

@Component({
  imports: [PillSelectComponent],
  template: `
    <div class="around-trigger"><app-pill-select [options]="options" value="a" /></div>
    <div class="unrelated-pane"></div>
  `,
})
class HostComponent {
  protected readonly options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
}

describe('PillSelectComponent scroll dismissal', () => {
  let root: HTMLElement | null = null;

  afterEach(() => {
    root?.remove();
    root = null;
  });

  async function openMenu(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(HostComponent);
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.pill-select__trigger')!.click();
    await fixture.whenStable();
    expect(root.querySelector('.pill-select__menu')).not.toBeNull();
    return root;
  }

  async function scroll(el: Element, host: HTMLElement): Promise<boolean> {
    el.dispatchEvent(new Event('scroll'));
    await TestBed.inject(ApplicationRef).whenStable();
    return host.querySelector('.pill-select__menu') !== null;
  }

  it('stays open when an unrelated pane scrolls', async () => {
    const host = await openMenu();
    expect(await scroll(host.querySelector('.unrelated-pane')!, host)).toBe(true);
  });

  it('stays open when its own menu scrolls', async () => {
    const host = await openMenu();
    expect(await scroll(host.querySelector('.pill-select__menu')!, host)).toBe(true);
  });

  it('closes when a scroller around the trigger scrolls', async () => {
    const host = await openMenu();
    expect(await scroll(host.querySelector('.around-trigger')!, host)).toBe(false);
  });
});
