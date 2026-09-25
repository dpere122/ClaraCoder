import { Component, ViewEncapsulation, computed, inject, input, output, signal, OnDestroy } from '@angular/core';
import type { DiffReviewStatus, ThemeProposalFinishedEvent, ThemeProposalPayload } from '@shared/index';
import {
  builtInThemeForMode,
  validateThemeDocument,
  type ClaraThemeDocument,
  type ThemeValidationResult,
} from '@shared/theme';
import { ElectronService } from '../../../core/electron.service';
import { ThemeEngineService } from '../../../core/theme/theme-engine.service';

const SWATCH_TOKENS = ['--t-bg', '--t-bg-surface', '--t-primary', '--t-secondary', '--t-fg', '--t-confirm', '--t-caution'];

/**
 * HITL card for an agent-authored theme (`propose_theme`). Preview toggles a live preview in
 * every window, Save writes it to the theme library (optionally making it active), Dismiss
 * resolves the card. Nothing here round-trips to Python.
 */
@Component({
  selector: 'app-theme-proposal',
  standalone: true,
  templateUrl: './theme-proposal.html',
  styleUrl: './theme-proposal.css',
  encapsulation: ViewEncapsulation.None,
})
export class ThemeProposalComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly engine = inject(ThemeEngineService);

  readonly payload = input.required<ThemeProposalPayload>();
  readonly reviewStatus = input<DiffReviewStatus>('pending');
  readonly reviewSummary = input<string | undefined>(undefined);

  readonly themeProposalFinished = output<ThemeProposalFinishedEvent>();

  readonly busy = signal(false);
  readonly previewing = signal(false);
  readonly error = signal('');
  readonly savedId = signal<string | null>(null);

  /** Re-validated locally; the card refuses to preview or save an unusable document. */
  readonly validation = computed<ThemeValidationResult>(() => validateThemeDocument(this.payload().theme));
  readonly doc = computed<ClaraThemeDocument | null>(() => this.validation().doc);

  readonly swatches = computed<string[]>(() => {
    const doc = this.doc();
    if (!doc) {
      return [];
    }
    const base = builtInThemeForMode(doc.mode).tokens;
    return SWATCH_TOKENS.map((name) => doc.tokens[name] ?? base[name] ?? 'transparent');
  });

  readonly tokenCount = computed(() => Object.keys(this.doc()?.tokens ?? {}).length);
  readonly groupCount = computed(() => Object.keys(this.doc()?.groups ?? {}).length);
  readonly notes = computed<string[]>(() => {
    const backend = this.payload().warnings ?? [];
    const local = this.validation().warnings.map((w) => `${w.path}: ${w.message}`);
    const seen = new Set<string>();
    return [...backend, ...local].filter((n) => (seen.has(n) ? false : (seen.add(n), true))).slice(0, 8);
  });

  ngOnDestroy(): void {
    if (this.previewing()) {
      void this.electron.previewTheme(null);
    }
  }

  async togglePreview(): Promise<void> {
    const doc = this.doc();
    if (!doc || this.busy()) {
      return;
    }
    if (this.previewing()) {
      this.previewing.set(false);
      await this.electron.previewTheme(null);
      return;
    }
    this.previewing.set(true);
    await this.electron.previewTheme(doc);
  }

  /** Save to the library. `apply` also makes it the active theme. */
  async save(apply: boolean): Promise<void> {
    const doc = this.doc();
    if (!doc || this.busy() || this.reviewStatus() !== 'pending') {
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      // Let main allocate a unique id (the proposal may reuse an existing one).
      const created = await this.electron.createTheme({ name: doc.name, mode: doc.mode });
      if (!created.ok || !created.theme) {
        this.error.set(created.error ?? 'Could not create the theme.');
        return;
      }
      const toSave: ClaraThemeDocument = { ...doc, id: created.theme.id, builtIn: undefined };
      delete toSave.builtIn;
      const saved = await this.electron.saveTheme(toSave);
      if (!saved.ok || !saved.theme) {
        await this.electron.deleteTheme(created.theme.id);
        const detail = saved.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
        this.error.set(saved.error ? `${saved.error}${detail ? ` — ${detail}` : ''}` : 'Could not save the theme.');
        return;
      }
      this.savedId.set(saved.theme.id);
      this.engine.setLibrary([...this.engine.library().filter((t) => t.id !== saved.theme!.id), saved.theme]);
      if (this.previewing()) {
        this.previewing.set(false);
        await this.electron.previewTheme(null);
      }
      if (apply) {
        await this.electron.setTheme(saved.theme.id);
      }
      this.themeProposalFinished.emit({
        requestId: this.payload().requestId,
        status: 'complete',
        summary: apply ? `Saved and applied "${saved.theme.name}".` : `Saved "${saved.theme.name}" to Settings → Themes.`,
        savedThemeId: saved.theme.id,
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  async dismiss(): Promise<void> {
    if (this.busy() || this.reviewStatus() !== 'pending') {
      return;
    }
    if (this.previewing()) {
      this.previewing.set(false);
      await this.electron.previewTheme(null);
    }
    this.themeProposalFinished.emit({
      requestId: this.payload().requestId,
      status: 'cancelled',
      summary: 'Theme proposal dismissed.',
    });
  }
}
