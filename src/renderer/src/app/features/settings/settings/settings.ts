import { Component, OnDestroy, OnInit, ViewEncapsulation, inject } from '@angular/core';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ThemedConfirmDialogComponent } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog';
import { ThemedPromptDialogComponent } from '../../../shared/themed-prompt-dialog/themed-prompt-dialog';
import { SettingsAudio } from '../settings-audio/settings-audio';
import { SettingsGeneral } from '../settings-general/settings-general';
import { SettingsModelManager } from '../settings-model-manager/settings-model-manager';
import { SettingsModels } from '../settings-models/settings-models';
import { SettingsMonaco } from '../settings-monaco/settings-monaco';
import { SettingsThemes } from '../settings-themes/settings-themes';
import { SettingsMcp } from '../settings-mcp/settings-mcp';
import { SettingsTools } from '../settings-tools/settings-tools';
import { SettingsWorkspaces } from '../settings-workspaces/settings-workspaces';
import { SettingsStore } from './settings-store';

/**
 * Settings window shell: nav, overview header, footer persist actions, and tab host.
 * Tab panes live in sibling feature folders; shared form state is {@link SettingsStore}.
 */
@Component({
  selector: 'app-settings',
  imports: [
    FormsModule,
    LucideAngularModule,
    ThemedConfirmDialogComponent,
    ThemedPromptDialogComponent,
    NgxSpinnerComponent,
    SettingsGeneral,
    SettingsThemes,
    SettingsModels,
    SettingsModelManager,
    SettingsTools,
    SettingsMcp,
    SettingsMonaco,
    SettingsAudio,
    SettingsWorkspaces,
  ],
  providers: [SettingsStore],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  encapsulation: ViewEncapsulation.None,
})
export class Settings implements OnInit, OnDestroy {
  /** Store is the template API for shell chrome (nav summaries, footer, tab routing). */
  protected readonly s = inject(SettingsStore);

  async ngOnInit(): Promise<void> {
    await this.s.ngOnInit();
  }

  ngOnDestroy(): void {
    this.s.ngOnDestroy();
  }
}
