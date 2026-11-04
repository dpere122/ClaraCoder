import { Component, ViewEncapsulation } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { PillSelectComponent } from '../../../../shared/pill-select/pill-select';

/**
 * What a local source looks like, for the tour to point at when there is no real one to show.
 * Static on purpose: it reads nothing from the store and every control is disabled, so it cannot
 * reach the Settings draft. It reuses the real data-tutorial names, and only ever replaces the
 * real editor, so the two never both match a step.
 */
@Component({
  selector: 'app-tutorial-source-example',
  imports: [LucideAngularModule, PillSelectComponent],
  templateUrl: './tutorial-source-example.html',
  // The run command's own stylesheet loads only once that component has rendered.
  styleUrls: ['./tutorial-source-example.css', '../llama-run-command/llama-run-command.css'],
  encapsulation: ViewEncapsulation.None,
})
export class TutorialSourceExampleComponent {
  protected readonly modelOptions = [{ id: 'example', label: 'EXAMPLE-model-7B-Q4_K_M.gguf (not real)' }];
  protected readonly templateOptions = [{ id: 'example', label: 'Example template' }];
  protected readonly flags = [
    { flag: '-m', longName: '--model', value: 'C:\\example\\EXAMPLE-model-7B-Q4_K_M.gguf' },
    { flag: '-c', longName: '--ctx-size', value: '8192' },
    { flag: '-ngl', longName: '--gpu-layers', value: '99' },
    { flag: '--jinja', longName: '', value: '' },
  ];
  protected readonly commonFlags = ['--threads', '--batch-size', '--mlock'];
}
