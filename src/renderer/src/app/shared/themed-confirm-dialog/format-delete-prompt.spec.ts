import { describe, expect, it } from 'vitest';
import { dependencyDeletePrompt } from './format-delete-prompt';

describe('dependencyDeletePrompt', () => {
  it('warns that deleting the Python runtime stops the backend', () => {
    const p = dependencyDeletePrompt({ id: 'python-runtime', label: 'Python runtime', path: 'C:\venv' });
    expect(p.title).toBe('Delete Python runtime?');
    expect(p.message).toContain("Clara's backend");
    expect(p.detail).toContain('C:\venv');
    expect(p).toMatchObject({ confirmText: 'Delete', cancelText: 'Cancel', variant: 'warning' });
  });

  it('falls back to generic copy without a path', () => {
    const p = dependencyDeletePrompt({ id: 'kokoro', label: 'Kokoro TTS', path: null });
    expect(p.message).toBe('You can download it again later.');
    expect(p.detail).toBe("This can't be undone.");
  });
});
