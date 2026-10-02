import { Component, model, ViewEncapsulation } from '@angular/core';
import { DEFAULT_KOKORO_TTS_VOICE } from '@shared/index';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';

export interface VoiceOption {
  id: string;
  label: string;
}

/** Kokoro (local TTS) voices — American ``af_*`` / ``am_*``, British ``bf_*`` / ``bm_*``, Spanish ``ef_*`` / ``em_*``. */
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'af_heart', label: 'American • Heart (default)' },
  { id: 'af_bella', label: 'American • Bella' },
  { id: 'af_nicole', label: 'American • Nicole' },
  { id: 'af_sarah', label: 'American • Sarah' },
  { id: 'af_sky', label: 'American • Sky' },
  { id: 'am_adam', label: 'American • Adam' },
  { id: 'am_michael', label: 'American • Michael' },
  { id: 'bf_emma', label: 'British • Emma' },
  { id: 'bf_isabella', label: 'British • Isabella' },
  { id: 'bm_george', label: 'British • George' },
  { id: 'bm_lewis', label: 'British • Lewis' },
  { id: 'ef_dora', label: 'Spanish • Dora' },
  { id: 'em_alex', label: 'Spanish • Alex' },
  { id: 'em_santa', label: 'Spanish • Santa' },
];

@Component({
  selector: 'app-speech-module',
  imports: [PillSelectComponent],
  templateUrl: './speech-module.html',
  styleUrl: './speech-module.css',
  encapsulation: ViewEncapsulation.None
})
export class SpeechModule {
  readonly selectedVoice = model(DEFAULT_KOKORO_TTS_VOICE);
  readonly voices = VOICE_OPTIONS;

  onVoiceChange(id: string): void {
    this.selectedVoice.set(id);
  }
}
