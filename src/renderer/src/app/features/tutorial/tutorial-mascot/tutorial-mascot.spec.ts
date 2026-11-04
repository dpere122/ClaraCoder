import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TutorialMascotComponent } from './tutorial-mascot';

function createMascot(): ComponentFixture<TutorialMascotComponent> {
  return TestBed.createComponent(TutorialMascotComponent);
}

function mascot(fixture: ComponentFixture<TutorialMascotComponent>): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector('.tutorial-mascot');
}

function componentStyles(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .find((text) => text.includes('.tutorial-mascot__mark')) ?? '';
}

beforeEach(() => TestBed.resetTestingModule());

describe('TutorialMascotComponent', () => {
  it('is decorative, pointer-transparent, and shows only the local Clara mark', () => {
    const fixture = createMascot();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const overlay = mascot(fixture)!;
    const mark = overlay.querySelector('.tutorial-mascot__mark') as HTMLElement;

    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('a, button, input, [tabindex]')).toBeNull();
    expect(getComputedStyle(overlay).pointerEvents).toBe('none');
    expect(getComputedStyle(mark).pointerEvents).toBe('none');
    expect(overlay.children).toHaveLength(1);
    expect(mark.style.getPropertyValue('--tutorial-mascot-icon')).toContain('app-icon-etch.png');
    expect(componentStyles()).toContain('var(--t-primary)');
  });

  it('flows inside its parent rather than floating over the viewport', () => {
    const fixture = createMascot();
    fixture.detectChanges();
    expect(getComputedStyle(mascot(fixture)!).position).not.toBe('fixed');
    expect(getComputedStyle(mascot(fixture)!).float).toBe('left');
    expect(componentStyles()).not.toContain('--tutorial-mascot-x');
  });

  it('leaves fading to the card it sits in', () => {
    const fixture = createMascot();
    fixture.detectChanges();
    expect(componentStyles()).not.toContain('fade-in');
    expect(getComputedStyle(mascot(fixture)!).animation).not.toContain('fade');
  });
});
