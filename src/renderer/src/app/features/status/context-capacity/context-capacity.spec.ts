import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ContextCapacityComponent } from './context-capacity';

describe('ContextCapacityComponent tooltips', () => {
  async function render() {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ContextCapacityComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ContextCapacityComponent);
    fixture.componentRef.setInput('usedTokens', 1_200);
    fixture.componentRef.setInput('maxTokens', 8_000);
    fixture.componentRef.setInput('remainingTokens', 6_800);
    fixture.componentRef.setInput('usedPercentage', 15);
    fixture.componentRef.setInput('compact', true);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      '.context-capacity__circle-button',
    ) as HTMLButtonElement;
    return { fixture, button };
  }

  it('keeps the native title as fallback until the custom tooltip opens', async () => {
    const { button } = await render();
    expect(button.getAttribute('title')).toContain('tokens');
    expect(button.classList.contains('context-capacity__circle-button--tooltip-open')).toBe(false);
  });

  it('strips the native title while the custom tooltip is open', async () => {
    const { fixture, button } = await render();
    button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    fixture.detectChanges();

    expect(button.hasAttribute('title')).toBe(false);
    expect(button.classList.contains('context-capacity__circle-button--tooltip-open')).toBe(true);

    button.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    fixture.detectChanges();

    expect(button.getAttribute('title')).toContain('tokens');
    expect(button.classList.contains('context-capacity__circle-button--tooltip-open')).toBe(false);
  });

  it('does not restore the native title on focusout while the pointer is still over the circle', async () => {
    const { fixture, button } = await render();
    button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    fixture.detectChanges();
    expect(button.hasAttribute('title')).toBe(false);

    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    fixture.detectChanges();
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.classList.contains('context-capacity__circle-button--tooltip-open')).toBe(true);
  });
});
