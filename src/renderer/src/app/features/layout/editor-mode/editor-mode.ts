import { Component, model, ViewEncapsulation } from '@angular/core';

@Component({
  selector: 'app-editor-mode',
  templateUrl: './editor-mode.html',
  styleUrl: './editor-mode.css',
  encapsulation: ViewEncapsulation.None,
})
export class EditorMode {
  /**
   * When true, the backend binds edit tools (`apply_mode`). When false, the model is read/search only.
   */
  readonly editorMode = model(true);

  toggle(): void {
    this.editorMode.set(!this.editorMode());
  }
}
