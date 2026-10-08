import { Component, ViewEncapsulation, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { LucideAngularModule } from 'lucide-angular';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-model-manager',
  imports: [FormsModule, LucideAngularModule, NgxSpinnerComponent, PillSelectComponent],
  templateUrl: './settings-model-manager.html',
  styleUrl: './settings-model-manager.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsModelManager {
  protected readonly s = inject(SettingsStore);

  protected hfCountOptions(values: readonly number[], allowMillions: boolean): { id: string; label: string }[] {
    return values.map((opt) => ({
      id: String(opt),
      label:
        opt === 0
          ? 'Any'
          : allowMillions && opt >= 1_000_000
            ? `${opt / 1_000_000}M+`
            : opt >= 1_000
              ? `${opt / 1_000}k+`
              : `${opt}+`,
    }));
  }
}
