import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { LucideAngularModule } from 'lucide-angular';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-model-manager',
  imports: [FormsModule, LucideAngularModule, NgxSpinnerComponent],
  templateUrl: './settings-model-manager.html',
  styleUrl: './settings-model-manager.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsModelManager {
  protected readonly s = inject(SettingsStore);
}
