import { Component, ViewEncapsulation, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-workspaces',
  imports: [LucideAngularModule],
  templateUrl: './settings-workspaces.html',
  styleUrl: './settings-workspaces.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsWorkspaces {
  protected readonly s = inject(SettingsStore);
}
