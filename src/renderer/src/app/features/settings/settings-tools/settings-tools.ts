import { Component, OnInit, ViewEncapsulation, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WEB_SEARCH_ENGINES } from '@shared/index';
import type { ScreenshotStorageStats } from '@shared/screenshot-retention';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { ThemedConfirmDialogService } from '../../../shared/themed-confirm-dialog/themed-confirm-dialog.service';
import { SettingsStore } from '../settings/settings-store';

@Component({
  selector: 'app-settings-tools',
  imports: [FormsModule, PillSelectComponent],
  templateUrl: './settings-tools.html',
  styleUrl: './settings-tools.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsTools implements OnInit {
  protected readonly s = inject(SettingsStore);
  protected readonly engines = WEB_SEARCH_ENGINES;
  private readonly electron = inject(ElectronService);
  private readonly confirm = inject(ThemedConfirmDialogService);
  readonly screenshotStats = signal<ScreenshotStorageStats | null>(null);
  readonly screenshotStorageBusy = signal(false);
  readonly screenshotStorageError = signal('');

  ngOnInit(): void {
    void this.refreshScreenshotStorage();
  }

  screenshotMiB(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  async refreshScreenshotStorage(): Promise<void> {
    await this.screenshotStorageAction(() => this.electron.getScreenshotStorageStats());
  }

  async runScreenshotCleanup(): Promise<void> {
    await this.screenshotStorageAction(() => this.electron.runScreenshotCleanup());
  }

  async clearScreenshots(): Promise<void> {
    if (this.screenshotStorageBusy()) {
      return;
    }
    const result = await this.confirm.open({
      title: 'Clear screenshots?',
      message: 'Permanently delete all saved screenshots from this app?',
      detail: 'Conversation text is kept, but screenshot previews will no longer be available. This cannot be undone.',
      confirmText: 'Clear screenshots',
      variant: 'warning',
    });
    if (result === 'confirm') {
      await this.screenshotStorageAction(() => this.electron.clearScreenshots());
    }
  }

  private async screenshotStorageAction(
    action: () => Promise<{ ok: true; stats: ScreenshotStorageStats } | { ok: false; error: string }>,
  ): Promise<void> {
    if (this.screenshotStorageBusy()) {
      return;
    }
    this.screenshotStorageBusy.set(true);
    this.screenshotStorageError.set('');
    try {
      const result = await action();
      if (result.ok) {
        this.screenshotStats.set(result.stats);
      } else {
        this.screenshotStorageError.set(result.error);
      }
    } catch (error) {
      this.screenshotStorageError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.screenshotStorageBusy.set(false);
    }
  }
}
