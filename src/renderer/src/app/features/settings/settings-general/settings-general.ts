import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FontControl } from '../../layout/font-control/font-control';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-general',
  imports: [FormsModule, FontControl, PillSelectComponent],
  templateUrl: './settings-general.html',
  styleUrl: './settings-general.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsGeneral {
  protected readonly s = inject(SettingsStore);

  protected fontOptions(
    builtin: readonly { stack: string; label: string }[],
    system: readonly { stack: string; label: string }[],
  ): { id: string; label: string; group?: string }[] {
    return [
      ...builtin.map((opt) => ({ id: opt.stack, label: opt.label })),
      ...system.map((opt) => ({ id: opt.stack, label: opt.label, group: 'System fonts' })),
    ];
  }
}
