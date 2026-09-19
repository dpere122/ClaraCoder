import { afterNextRender, type Injector } from '@angular/core';
import type { NgxSpinnerService } from 'ngx-spinner';

/** Same inline loader as the managed llama-server Start button. */
export const HITL_BTN_SPINNER_TYPE = 'ball-pulse-sync' as const;

export const HITL_BTN_SPINNER = {
  fullScreen: false as const,
  bdColor: 'rgba(0,0,0,0)',
  size: 'small' as const,
  color: 'currentColor',
  type: HITL_BTN_SPINNER_TYPE,
};

export function newHitlBtnSpinnerName(prefix: string): string {
  return `hitl-btn-${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function scheduleHitlBtnSpinner(
  ngxSpinner: NgxSpinnerService,
  name: string,
  show: boolean,
  injector: Injector,
): void {
  afterNextRender(
    () => {
      if (show) {
        void ngxSpinner.show(name, HITL_BTN_SPINNER);
      } else {
        void ngxSpinner.hide(name);
      }
    },
    { injector },
  );
}
