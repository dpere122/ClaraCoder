import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FontControl } from '../../layout/font-control/font-control';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-general',
  imports: [FormsModule, FontControl],
  templateUrl: './settings-general.html',
  styleUrl: './settings-general.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsGeneral {
  protected readonly s = inject(SettingsStore);
}
