import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-monaco',
  imports: [FormsModule],
  templateUrl: './settings-monaco.html',
  styleUrl: './settings-monaco.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsMonaco {
  protected readonly s = inject(SettingsStore);
}
