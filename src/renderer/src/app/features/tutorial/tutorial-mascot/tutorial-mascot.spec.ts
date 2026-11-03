import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { TutorialMascotComponent } from './tutorial-mascot';

function createMascot(): ComponentFixture<TutorialMascotComponent> {
  return TestBed.createComponent(TutorialMascotComponent);
}

function mascot(fixture: ComponentFixture<TutorialMascotComponent>): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector('.tutorial-mascot');
}

function departure(fixture: ComponentFixture<TutorialMascotComponent>): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector('.tutorial-mascot-departure');
}

function componentStyles(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .find((text) => text.includes('.tutorial-mascot__mark')) ?? '';
}

beforeEach(() => TestBed.resetTestingModule());

describe('TutorialMascotComponent', () => {
  it('waits for a finite viewport destination, including accepting zero', () => {
    const fixture = createMascot();
    fixture.detectChanges();
    expect(mascot(fixture)).toBeNull();

    fixture.componentRef.setInput('destination', { x: NaN, y: 10 });
    fixture.detectChanges();
    expect(mascot(fixture)).toBeNull();

    fixture.componentRef.setInput('destination', { x: 0, y: 0 });
    fixture.detectChanges();
    expect(mascot(fixture)).not.toBeNull();

    fixture.componentRef.setInput('destination', { x: 10, y: Infinity });
    fixture.detectChanges();
    expect(mascot(fixture)).toBeNull();
  });

  it('is decorative, pointer-transparent, and shows only the local Clara mark', () => {
    const fixture = createMascot();
    fixture.componentRef.setInput('destination', { x: 150.5, y: 240 });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const overlay = mascot(fixture)!;
    const mark = overlay.querySelector('img') as HTMLImageElement;

    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('a, button, input, [tabindex]')).toBeNull();
    expect(getComputedStyle(overlay).pointerEvents).toBe('none');
    expect(getComputedStyle(mark).pointerEvents).toBe('none');
    expect(getComputedStyle(overlay).position).toBe('fixed');
    expect(overlay.children).toHaveLength(1);
    expect(mark.getAttribute('src')).toBe('app-icon-etch.png');
    expect(mark.getAttribute('alt')).toBe('');
    expect(overlay.style.getPropertyValue('--tutorial-mascot-x')).toBe('150.5px');
    expect(overlay.style.getPropertyValue('--tutorial-mascot-y')).toBe('240px');
  });

  it('moves between locations with opacity alone', () => {
    const fixture = createMascot();
    fixture.componentRef.setInput('destination', { x: 120, y: 120 });
    fixture.detectChanges();
    const styles = componentStyles();
    for (const name of ['fade-in', 'fade-out']) {
      const keyframes = new RegExp(`@keyframes\\s+[^\\s{]*tutorial-mascot-${name}\\s*\\{([\\s\\S]*?)\\}\\s*\\}`).exec(styles)?.[1] ?? '';
      expect(keyframes).toContain('opacity');
      expect(keyframes).not.toContain('transform');
    }
    expect(getComputedStyle(mascot(fixture)!).animation).toContain('tutorial-mascot-fade-in');
  });

  it('fades out of the previous location when the key changes or the destination clears', () => {
    const fixture = createMascot();
    fixture.componentRef.setInput('transitionKey', 'first');
    fixture.detectChanges();
    fixture.componentRef.setInput('transitionKey', 'unplaced');
    fixture.detectChanges();
    expect(departure(fixture)).toBeNull();

    fixture.componentRef.setInput('destination', { x: 100, y: 120 });
    fixture.detectChanges();
    expect(departure(fixture)).toBeNull();

    fixture.componentRef.setInput('destination', null);
    fixture.componentRef.setInput('transitionKey', 'second');
    fixture.detectChanges();
    const leaving = departure(fixture)!;
    expect(mascot(fixture)).toBeNull();
    expect(leaving.style.getPropertyValue('--tutorial-mascot-x')).toBe('100px');
    expect(leaving.style.getPropertyValue('--tutorial-mascot-y')).toBe('120px');
    expect(leaving.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(leaving).pointerEvents).toBe('none');
    expect(getComputedStyle(leaving).animation).toContain('tutorial-mascot-fade-out');
    expect(leaving.querySelector('img')?.getAttribute('src')).toBe('app-icon-etch.png');

    fixture.componentRef.setInput('destination', { x: 300, y: 320 });
    fixture.detectChanges();
    expect(departure(fixture)).toBe(leaving);
    expect(mascot(fixture)!.style.getPropertyValue('--tutorial-mascot-x')).toBe('300px');

    leaving.dispatchEvent(new Event('animationend'));
    fixture.detectChanges();
    expect(departure(fixture)).toBeNull();

    fixture.componentRef.setInput('destination', { x: 400, y: 420 });
    fixture.detectChanges();
    expect(departure(fixture)).toBeNull();

    fixture.componentRef.setInput('destination', { x: 500, y: 520 });
    fixture.componentRef.setInput('transitionKey', 'third');
    fixture.detectChanges();
    expect(departure(fixture)!.style.getPropertyValue('--tutorial-mascot-x')).toBe('400px');
    expect(mascot(fixture)!.style.getPropertyValue('--tutorial-mascot-x')).toBe('500px');
  });

  it('clamps the responsive scale without recreating the animation', () => {
    const fixture = createMascot();
    fixture.componentRef.setInput('destination', { x: 120, y: 120 });
    fixture.componentRef.setInput('scale', 0.7);
    fixture.detectChanges();
    const first = mascot(fixture)!;
    expect(first.style.getPropertyValue('--tutorial-mascot-scale')).toBe('0.7');
    fixture.componentRef.setInput('scale', 0.1);
    fixture.detectChanges();
    expect(mascot(fixture)).toBe(first);
    expect(first.style.getPropertyValue('--tutorial-mascot-scale')).toBe('0.4');
    fixture.componentRef.setInput('scale', NaN);
    fixture.detectChanges();
    expect(first.style.getPropertyValue('--tutorial-mascot-scale')).toBe('1');
  });

  it('updates the target without replaying, and replays only when the key changes', () => {
    const fixture = createMascot();
    fixture.componentRef.setInput('destination', { x: 100, y: 120 });
    fixture.componentRef.setInput('transitionKey', 'first');
    fixture.detectChanges();
    const first = mascot(fixture)!;

    fixture.componentRef.setInput('destination', { x: 300, y: 320 });
    fixture.componentRef.setInput('transitionKey', 'first');
    fixture.detectChanges();
    expect(mascot(fixture)).toBe(first);
    expect(first.style.getPropertyValue('--tutorial-mascot-x')).toBe('300px');
    expect(first.style.getPropertyValue('--tutorial-mascot-y')).toBe('320px');

    fixture.componentRef.setInput('transitionKey', 'second');
    fixture.detectChanges();
    const second = mascot(fixture)!;
    expect(second).not.toBe(first);
    expect(second.style.getPropertyValue('--tutorial-mascot-x')).toBe('300px');
    expect(first.isConnected).toBe(false);

    fixture.componentRef.setInput('transitionKey', 'first');
    fixture.detectChanges();
    expect(mascot(fixture)).not.toBe(second);
  });

  it('keeps multiple mascot instances independent', () => {
    const firstFixture = createMascot();
    const secondFixture = createMascot();
    firstFixture.componentRef.setInput('destination', { x: 100, y: 120 });
    secondFixture.componentRef.setInput('destination', { x: 300, y: 320 });
    secondFixture.componentRef.setInput('celebration', true);
    firstFixture.detectChanges();
    secondFixture.detectChanges();
    const first = mascot(firstFixture)!;
    const second = mascot(secondFixture)!;

    expect(first.style.getPropertyValue('--tutorial-mascot-x')).toBe('100px');
    expect(second.style.getPropertyValue('--tutorial-mascot-x')).toBe('300px');
    expect(first.querySelector('.tutorial-mascot__sparkles')).toBeNull();
    expect(second.querySelector('.tutorial-mascot__sparkles')).not.toBeNull();
    firstFixture.componentRef.setInput('transitionKey', 'next');
    firstFixture.detectChanges();
    expect(mascot(firstFixture)).not.toBe(first);
    expect(mascot(secondFixture)).toBe(second);
  });

  it('plays celebration once per activation and restarts it with a new key', () => {
    const fixture = createMascot();
    fixture.componentRef.setInput('destination', { x: 200, y: 220 });
    fixture.detectChanges();
    expect(mascot(fixture)!.querySelector('.tutorial-mascot__sparkles')).toBeNull();

    fixture.componentRef.setInput('celebration', true);
    fixture.detectChanges();
    const overlay = mascot(fixture)!;
    const firstBurst = overlay.querySelector('.tutorial-mascot__sparkles') as HTMLElement;
    const finale = overlay.querySelector('.tutorial-mascot__celebration') as HTMLElement;
    expect(firstBurst.querySelectorAll('span')).toHaveLength(5);
    expect(finale.querySelectorAll('.tutorial-mascot__ring')).toHaveLength(2);
    expect(finale.querySelectorAll('.tutorial-mascot__rays span')).toHaveLength(8);
    expect(finale.querySelectorAll('.tutorial-mascot__confetti span')).toHaveLength(8);
    expect(getComputedStyle(finale).pointerEvents).toBe('none');
    expect(getComputedStyle(overlay.querySelector<HTMLElement>('.tutorial-mascot__mark')!).animation).toContain('tutorial-mascot-hero');
    const animation = getComputedStyle(firstBurst).animation;
    expect(animation).toContain('tutorial-mascot-celebrate');
    expect(animation).toContain('1450ms');
    expect(animation).toContain('460ms');
    expect(animation).not.toContain('infinite');
    fixture.detectChanges();
    expect(mascot(fixture)!.querySelector('.tutorial-mascot__sparkles')).toBe(firstBurst);

    fixture.componentRef.setInput('transitionKey', 'next');
    fixture.detectChanges();
    const nextBurst = mascot(fixture)!.querySelector('.tutorial-mascot__sparkles');
    expect(nextBurst).not.toBe(firstBurst);
    fixture.componentRef.setInput('celebration', false);
    fixture.detectChanges();
    expect(mascot(fixture)!.querySelector('.tutorial-mascot__sparkles')).toBeNull();
    fixture.componentRef.setInput('celebration', true);
    fixture.detectChanges();
    expect(mascot(fixture)!.querySelector('.tutorial-mascot__sparkles')).not.toBe(nextBurst);
  });

  it('provides a static mark at the destination for reduced motion', () => {
    const fixture = createMascot();
    fixture.componentRef.setInput('destination', { x: 100, y: 100 });
    fixture.detectChanges();
    const styles = componentStyles();
    const media = /@media\s*\(prefers-reduced-motion:\s*reduce\)/.exec(styles);
    expect(media).not.toBeNull();
    const reducedStyles = styles.slice(media!.index);
    expect(reducedStyles).toContain('animation: none !important');
    expect(reducedStyles).toContain('transition: none !important');
    expect(reducedStyles).toContain('.tutorial-mascot-departure');
    expect(reducedStyles).toContain('.tutorial-mascot__celebration');
    expect(reducedStyles).toContain('display: none');
    expect(reducedStyles).toContain('transform: none');
    expect(styles).toContain('calc(var(--tutorial-mascot-x) - 52px)');
    expect(styles).toContain('calc(var(--tutorial-mascot-y) - 60px)');
  });
});
