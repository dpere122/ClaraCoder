import { describe, expect, it } from 'vitest';
import { dependencyDeletePrompt } from './format-delete-prompt';

describe('dependencyDeletePrompt', () => {
  it('says what stops working when llama-server is deleted', () => {
    const p = dependencyDeletePrompt({ id: 'llama-server', label: 'llama-server', path: 'C:/runtime/bin' });
    expect(p.title).toBe('Delete llama-server?');
    expect(p.message).toContain('Managed local models');
    expect(p.detail).toContain('C:/runtime/bin');
    expect(p).toMatchObject({ confirmText: 'Delete', cancelText: 'Cancel', variant: 'warning' });
  });

  it('falls back to generic copy without a path', () => {
    const p = dependencyDeletePrompt({ id: 'kokoro', label: 'Kokoro TTS', path: null });
    expect(p.message).toBe('You can download it again later.');
    expect(p.detail).toBe("This can't be undone.");
  });
});
