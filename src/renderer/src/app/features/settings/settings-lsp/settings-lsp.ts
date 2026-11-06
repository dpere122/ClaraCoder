import { Component, DestroyRef, ViewEncapsulation, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LSP_SERVER_CATALOG, type GdscriptDiagnosticsProfile, type GdscriptLspSettings } from '@shared/lsp-settings';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-lsp',
  imports: [FormsModule, PillSelectComponent],
  templateUrl: './settings-lsp.html',
  styleUrl: './settings-lsp.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsLsp {
  protected readonly s = inject(SettingsStore);
  private readonly electron = inject(ElectronService);

  protected readonly server = computed(
    () => LSP_SERVER_CATALOG.find((entry) => entry.id === this.s.activeSubTabId('lsp')) ?? LSP_SERVER_CATALOG[0]!,
  );
  protected readonly godot = computed(() => this.s.lspServers().gdscript);
  /** The Dependencies row behind the Godot server, once the list has loaded. */
  protected readonly gdls = computed(() => this.s.lspDependencies().find((dep) => dep.id === 'gdls') ?? null);

  protected readonly profileOptions: ReadonlyArray<{ id: GdscriptDiagnosticsProfile; label: string }> = [
    { id: 'godot', label: "Godot (matches the editor's warnings)" },
    { id: 'strict', label: 'Strict (more warnings)' },
    { id: 'off', label: 'Off' },
  ];

  constructor() {
    void this.s.refreshLspDependencies();
    // Dependencies is its own window: pick up an install when the user comes back from it.
    const refresh = (): void => void this.s.refreshLspDependencies();
    window.addEventListener('focus', refresh);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('focus', refresh));
  }

  protected patch(patch: Partial<GdscriptLspSettings>): void {
    this.s.patchGdscriptLsp(patch);
  }

  protected async browseForGodot(): Promise<void> {
    const picked = await this.electron.openFileDialog();
    if (picked) {
      this.patch({ godotBinaryPath: picked });
    }
  }

  protected openDependencies(): void {
    this.electron.openDependenciesWindow();
  }
}
