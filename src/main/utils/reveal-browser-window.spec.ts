/**
 * Child windows hand focus back to the main window as they close (Windows z-order fix).
 */
import { describe, it, expect, vi } from 'vitest';
import { returnFocusToParentOnClose } from './reveal-browser-window';

function fakeWindows(childFocused: boolean) {
  const handlers = new Map<string, () => void>();
  const child = {
    isFocused: () => childFocused,
    on: vi.fn((event: string, cb: () => void) => void handlers.set(event, cb)),
  };
  const parent = {
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
  };
  return { handlers, child, parent };
}

describe('returnFocusToParentOnClose', () => {
  it('focuses the parent before a focused child window is destroyed', () => {
    const { handlers, child, parent } = fakeWindows(true);
    returnFocusToParentOnClose(child as never, parent as never);
    handlers.get('close')!();
    expect(parent.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves focus alone when the child was not the active window', () => {
    const { handlers, child, parent } = fakeWindows(false);
    returnFocusToParentOnClose(child as never, parent as never);
    handlers.get('close')!();
    expect(parent.focus).not.toHaveBeenCalled();
  });

  it('does not restore a minimized, hidden or destroyed parent', () => {
    const { handlers, child, parent } = fakeWindows(true);
    returnFocusToParentOnClose(child as never, parent as never);
    parent.isMinimized.mockReturnValue(true);
    handlers.get('close')!();
    parent.isMinimized.mockReturnValue(false);
    parent.isVisible.mockReturnValue(false);
    handlers.get('close')!();
    parent.isDestroyed.mockReturnValue(true);
    handlers.get('close')!();
    expect(parent.focus).not.toHaveBeenCalled();
  });

  it('does nothing without a parent', () => {
    const { child } = fakeWindows(true);
    returnFocusToParentOnClose(child as never, null);
    expect(child.on).not.toHaveBeenCalled();
  });
});
