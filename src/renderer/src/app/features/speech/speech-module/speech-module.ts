import { Component, model, ViewEncapsulation } from '@angular/core';

export interface VoiceOption {
  id: string;
  label: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'en-US-AriaNeural', label: 'Aria (US)' },
  { id: 'en-US-JennyNeural', label: 'Jenny (US)' },
  { id: 'en-US-GuyNeural', label: 'Guy (US)' },
  { id: 'en-US-DavisNeural', label: 'Davis (US)' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia (UK)' },
  { id: 'en-GB-RyanNeural', label: 'Ryan (UK)' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha (AU)' },
  { id: 'en-AU-WilliamNeural', label: 'William (AU)' },
];

@Component({
  selector: 'app-speech-module',
  templateUrl: './speech-module.html',
  styleUrl: './speech-module.css',
  encapsulation: ViewEncapsulation.None
})
export class SpeechModule {
  readonly speechEnabled = model(false);
  readonly selectedVoice = model('en-US-AriaNeural');
  readonly voices = VOICE_OPTIONS;

  toggle(): void {
    this.speechEnabled.set(!this.speechEnabled());
  }

  onVoiceChange(event: Event): void {
    this.selectedVoice.set((event.target as HTMLSelectElement).value);
  }
}
