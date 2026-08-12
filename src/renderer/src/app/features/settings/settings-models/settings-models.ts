import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { LucideAngularModule } from 'lucide-angular';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-models',
  imports: [FormsModule, LucideAngularModule, NgxSpinnerComponent],
  templateUrl: './settings-models.html',
  styleUrl: './settings-models.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsModels {
  protected readonly s = inject(SettingsStore);
}
