import { Component, ViewEncapsulation, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-audio',
  imports: [FormsModule, DecimalPipe, LucideAngularModule],
  templateUrl: './settings-audio.html',
  styleUrl: './settings-audio.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsAudio {
  protected readonly s = inject(SettingsStore);
}
