import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
}));

import { framelessWindowShapeOptions } from './harden-browser-window';

describe('framelessWindowShapeOptions', () => {
  it('disables Win11 DWM rounding so frameless chrome stays square', () => {
    expect(framelessWindowShapeOptions('win32')).toEqual({ roundedCorners: false });
  });

  it('leaves other platforms unchanged', () => {
    expect(framelessWindowShapeOptions('darwin')).toEqual({});
    expect(framelessWindowShapeOptions('linux')).toEqual({});
  });
});
