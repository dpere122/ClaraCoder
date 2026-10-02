import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-monaco',
  imports: [FormsModule, PillSelectComponent],
  templateUrl: './settings-monaco.html',
  styleUrl: './settings-monaco.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsMonaco {
  protected readonly s = inject(SettingsStore);
}
