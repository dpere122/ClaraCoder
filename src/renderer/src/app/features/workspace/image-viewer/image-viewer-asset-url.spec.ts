import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THUMB_MAX_EDGE,
  computeThumbDimensions,
  parseThumbMaxEdge,
} from '@shared/index';
import { buildWorkspaceImageAssetUrl } from './image-viewer-asset-url';

describe('buildWorkspaceImageAssetUrl', () => {
  it('returns empty for missing root or path', () => {
    expect(buildWorkspaceImageAssetUrl('', 'a.png')).toBe('');
    expect(buildWorkspaceImageAssetUrl('/ws', null)).toBe('');
  });

  it('builds a full-asset URL without thumb params', () => {
    expect(buildWorkspaceImageAssetUrl('/ws', 'photos/a.png')).toBe(
      'nemo-asset://workspace/?root=%2Fws&path=photos%2Fa.png',
    );
  });

  it('adds thumb=1 for gallery thumbnails', () => {
    expect(buildWorkspaceImageAssetUrl('/ws', 'a.gif', { thumb: true })).toBe(
      'nemo-asset://workspace/?root=%2Fws&path=a.gif&thumb=1',
    );
  });

  it('adds w= when a max edge is provided with thumb', () => {
    expect(buildWorkspaceImageAssetUrl('/ws', 'a.png', { thumb: true, maxEdge: 96 })).toBe(
      'nemo-asset://workspace/?root=%2Fws&path=a.png&thumb=1&w=96',
    );
  });

  it('returns empty for non-image paths so hidden viewer tabs do not 404', () => {
    expect(buildWorkspaceImageAssetUrl('/ws', '.project')).toBe('');
    expect(buildWorkspaceImageAssetUrl('/ws', 'src/Main.java')).toBe('');
  });
});

describe('parseThumbMaxEdge / computeThumbDimensions (protocol contract)', () => {
  it('maps thumb=1 to the default max edge', () => {
    expect(parseThumbMaxEdge('1', null)).toBe(DEFAULT_THUMB_MAX_EDGE);
  });

  it('scales oversized images into the max edge', () => {
    expect(computeThumbDimensions(1000, 500, 100)).toEqual({ width: 100, height: 50 });
  });
});
