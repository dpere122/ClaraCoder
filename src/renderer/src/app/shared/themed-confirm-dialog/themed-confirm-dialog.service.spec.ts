import { describe, expect, it } from 'vitest';
import { ThemedConfirmDialogService } from './themed-confirm-dialog.service';

describe('ThemedConfirmDialogService.openWithCheckbox', () => {
  it('resolves the chosen action together with the checkbox state', async () => {
    const svc = new ThemedConfirmDialogService();
    const pending = svc.openWithCheckbox({
      title: 'Move folder?',
      message: 'Move "a" into "b"?',
      checkboxLabel: "Don't ask again",
    });

    expect(svc.active()?.checkboxLabel).toBe("Don't ask again");
    expect(svc.checkboxChecked()).toBe(false);

    svc.setCheckboxChecked(true);
    svc.close('confirm');

    await expect(pending).resolves.toEqual({ result: 'confirm', checked: true });
    expect(svc.active()).toBeNull();
  });

  it('reports unchecked when the box is left alone', async () => {
    const svc = new ThemedConfirmDialogService();
    const pending = svc.openWithCheckbox({
      title: 'Move folder?',
      message: 'Move "a" into "b"?',
      checkboxLabel: "Don't ask again",
    });

    svc.close('cancel');

    await expect(pending).resolves.toEqual({ result: 'cancel', checked: false });
  });

  it('resets the checkbox state for each new dialog', async () => {
    const svc = new ThemedConfirmDialogService();
    const first = svc.openWithCheckbox({ title: 't', message: 'm', checkboxLabel: 'x' });
    svc.setCheckboxChecked(true);
    svc.close('confirm');
    await first;

    const second = svc.openWithCheckbox({ title: 't', message: 'm', checkboxLabel: 'x' });
    expect(svc.checkboxChecked()).toBe(false);
    svc.close('cancel');
    await second;
  });
});
