import { describe, expect, it, vi } from 'vitest';
import { askWorkspaceTrust, workspaceTrustPrompt } from './format-workspace-trust-prompt';
import type { ThemedConfirmResult } from './themed-confirm-dialog.service';

describe('workspaceTrustPrompt', () => {
  it('names the folder and what trust allows', () => {
    const prompt = workspaceTrustPrompt('engine', 'C:\\work\\engine');
    expect(prompt.title).toBe('Trust this folder?');
    expect(prompt.message).toContain('"engine"');
    expect(prompt.message).toContain('cargo');
    expect(prompt.detail).toContain('C:\\work\\engine');
    expect(prompt.confirmText).toBe('Trust');
    expect(prompt.cancelText).toBe("Don't trust");
    expect(prompt.variant).toBeUndefined();
  });
});

describe('askWorkspaceTrust', () => {
  it.each<[ThemedConfirmResult, boolean]>([
    ['confirm', true],
    ['cancel', false],
    ['middle', false],
  ])('treats %s as trusted=%s', async (result, trusted) => {
    const open = vi.fn().mockResolvedValue(result);
    expect(await askWorkspaceTrust({ open }, 'engine', '/work/engine')).toBe(trusted);
    expect(open).toHaveBeenCalledWith(workspaceTrustPrompt('engine', '/work/engine'));
  });
});
