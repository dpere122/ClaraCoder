import { describe, expect, it } from 'vitest';
import {
  auxiliaryPanelContentVisible,
  auxiliaryPanelShouldAutoScrollPreview,
  auxiliaryPanelStreamingPeek,
  initialAuxiliaryPanelMode,
  resolveAuxiliaryPanelModeForLive,
  toggleAuxiliaryPanelMode,
  transitionAuxiliaryPanelModeOnLiveChange,
  transitionAuxiliaryPanelModeOnPlanVisibleChange,
} from './auxiliary-stream-panel-modes';

describe('initialAuxiliaryPanelMode', () => {
  it('starts preview when live', () => {
    expect(initialAuxiliaryPanelMode(true)).toBe('preview');
  });

  it('starts collapsed when persisted', () => {
    expect(initialAuxiliaryPanelMode(false)).toBe('collapsed');
  });

  it('starts collapsed when live but plan panel is visible', () => {
    expect(initialAuxiliaryPanelMode(true, true)).toBe('collapsed');
  });
});

describe('auxiliaryPanelStreamingPeek', () => {
  it('is false when plan panel is visible during streaming', () => {
    expect(auxiliaryPanelStreamingPeek(true, true)).toBe(false);
  });
});

describe('toggleAuxiliaryPanelMode', () => {
  it('cycles preview and expanded while live', () => {
    expect(toggleAuxiliaryPanelMode('preview', true)).toBe('expanded');
    expect(toggleAuxiliaryPanelMode('expanded', true)).toBe('preview');
  });

  it('cycles collapsed and expanded when done', () => {
    expect(toggleAuxiliaryPanelMode('collapsed', false)).toBe('expanded');
    expect(toggleAuxiliaryPanelMode('expanded', false)).toBe('collapsed');
  });

  it('cycles collapsed and expanded when live but plan panel is visible', () => {
    expect(toggleAuxiliaryPanelMode('collapsed', true, true)).toBe('expanded');
    expect(toggleAuxiliaryPanelMode('expanded', true, true)).toBe('collapsed');
  });
});

describe('transitionAuxiliaryPanelModeOnPlanVisibleChange', () => {
  it('collapses preview when plan panel appears', () => {
    expect(transitionAuxiliaryPanelModeOnPlanVisibleChange('preview', false, true)).toBe('collapsed');
  });

  it('preserves expanded when plan panel appears', () => {
    expect(transitionAuxiliaryPanelModeOnPlanVisibleChange('expanded', false, true)).toBe('expanded');
  });

  it('restores preview when plan panel hides while collapsed', () => {
    expect(transitionAuxiliaryPanelModeOnPlanVisibleChange('collapsed', true, false)).toBe('preview');
  });
});

describe('transitionAuxiliaryPanelModeOnLiveChange', () => {
  it('maps preview to collapsed when stream ends', () => {
    expect(transitionAuxiliaryPanelModeOnLiveChange('preview', true, false)).toBe('collapsed');
  });

  it('preserves expanded when stream ends', () => {
    expect(transitionAuxiliaryPanelModeOnLiveChange('expanded', true, false)).toBe('expanded');
  });

  it('maps collapsed to preview when stream starts', () => {
    expect(transitionAuxiliaryPanelModeOnLiveChange('collapsed', false, true)).toBe('preview');
  });

  it('preserves expanded when stream starts', () => {
    expect(transitionAuxiliaryPanelModeOnLiveChange('expanded', false, true)).toBe('expanded');
  });

  it('is a no-op when live unchanged', () => {
    expect(transitionAuxiliaryPanelModeOnLiveChange('preview', true, true)).toBe('preview');
  });
});

describe('resolveAuxiliaryPanelModeForLive', () => {
  it('uses initial mode on first mount', () => {
    expect(resolveAuxiliaryPanelModeForLive('collapsed', true, undefined)).toBe('preview');
    expect(resolveAuxiliaryPanelModeForLive('collapsed', false, undefined)).toBe('collapsed');
  });

  it('applies transitions after mount', () => {
    expect(resolveAuxiliaryPanelModeForLive('preview', false, true)).toBe('collapsed');
    expect(resolveAuxiliaryPanelModeForLive('collapsed', true, false)).toBe('preview');
  });
});

describe('auxiliaryPanelContentVisible', () => {
  it('is false only in collapsed mode', () => {
    expect(auxiliaryPanelContentVisible('collapsed')).toBe(false);
    expect(auxiliaryPanelContentVisible('preview')).toBe(true);
    expect(auxiliaryPanelContentVisible('expanded')).toBe(true);
  });
});

describe('auxiliaryPanelShouldAutoScrollPreview', () => {
  it('is true only in preview mode', () => {
    expect(auxiliaryPanelShouldAutoScrollPreview('preview')).toBe(true);
    expect(auxiliaryPanelShouldAutoScrollPreview('collapsed')).toBe(false);
    expect(auxiliaryPanelShouldAutoScrollPreview('expanded')).toBe(false);
  });
});
