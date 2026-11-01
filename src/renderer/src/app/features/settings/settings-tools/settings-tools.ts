import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WEB_SEARCH_ENGINES } from '@shared/index';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-tools',
  imports: [FormsModule, PillSelectComponent],
  templateUrl: './settings-tools.html',
  styleUrl: './settings-tools.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsTools {
  protected readonly s = inject(SettingsStore);
  protected readonly engines = WEB_SEARCH_ENGINES;
}
