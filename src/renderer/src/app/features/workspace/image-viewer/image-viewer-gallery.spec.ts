import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@shared/index';
import {
  galleryIndexForPath,
  galleryNextIndex,
  galleryPreviousIndex,
  parentFolderAbsolutePath,
  parentFolderRelativePath,
  pickGalleryPathAfterRefresh,
  viewableImagesInDirectory,
  workspaceChangeAffectsGalleryFolder,
} from './image-viewer-gallery';

describe('parentFolderRelativePath', () => {
  it('returns parent folder for nested images', () => {
    expect(parentFolderRelativePath('photos/vacation/img.png')).toBe('photos/vacation');
  });

  it('returns empty string for workspace-root images', () => {
    expect(parentFolderRelativePath('logo.png')).toBe('');
  });

  it('normalizes slashes', () => {
    expect(parentFolderRelativePath('photos\\a.jpg')).toBe('photos');
  });
});

describe('parentFolderAbsolutePath', () => {
  it('joins workspace root with parent folder', () => {
    expect(parentFolderAbsolutePath('/ws', 'photos/a.png')).toBe('/ws/photos');
  });

  it('returns workspace root for root-level images', () => {
    expect(parentFolderAbsolutePath('/ws/', 'logo.png')).toBe('/ws');
  });
});

describe('viewableImagesInDirectory', () => {
  const root = '/ws';

  it('filters directories and non-viewable files', () => {
    const entries: FileEntry[] = [
      { name: 'readme.txt', path: '/ws/photos/readme.txt', isDirectory: false },
      { name: 'a.png', path: '/ws/photos/a.png', isDirectory: false },
      { name: 'nested', path: '/ws/photos/nested', isDirectory: true },
      { name: 'b.jpg', path: '/ws/photos/b.jpg', isDirectory: false },
      { name: 'icon.svg', path: '/ws/photos/icon.svg', isDirectory: false },
    ];
    expect(viewableImagesInDirectory(entries, root)).toEqual([
      'photos/a.png',
      'photos/b.jpg',
      'photos/icon.svg',
    ]);
  });

  it('sorts by filename', () => {
    const entries: FileEntry[] = [
      { name: 'z.png', path: '/ws/z.png', isDirectory: false },
      { name: 'a.png', path: '/ws/a.png', isDirectory: false },
    ];
    expect(viewableImagesInDirectory(entries, root)).toEqual(['a.png', 'z.png']);
  });
});

describe('galleryIndexForPath', () => {
  const paths = ['photos/a.png', 'photos/b.png'];

  it('finds current image index', () => {
    expect(galleryIndexForPath(paths, 'photos/b.png')).toBe(1);
  });

  it('returns -1 when path is missing', () => {
    expect(galleryIndexForPath(paths, 'photos/c.png')).toBe(-1);
  });
});

describe('gallery wrap navigation', () => {
  it('wraps previous from first to last', () => {
    expect(galleryPreviousIndex(0, 3)).toBe(2);
  });

  it('wraps next from last to first', () => {
    expect(galleryNextIndex(2, 3)).toBe(0);
  });
});

describe('workspaceChangeAffectsGalleryFolder', () => {
  it('matches sibling files in the gallery folder', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['photos/b.png'])).toBe(true);
  });

  it('matches workspace-root gallery for root-level files', () => {
    expect(workspaceChangeAffectsGalleryFolder('', ['logo.png'])).toBe(true);
  });

  it('ignores nested paths under other folders', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['photos/nested/x.png'])).toBe(false);
    expect(workspaceChangeAffectsGalleryFolder('photos', ['other/a.png'])).toBe(false);
  });

  it('treats "." as a full-tree refresh', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['.'])).toBe(true);
  });

  it('matches previousPaths for renames out of the folder', () => {
    expect(
      workspaceChangeAffectsGalleryFolder('photos', ['elsewhere/a.png'], ['photos/a.png']),
    ).toBe(true);
  });

  it('matches when the gallery folder path itself changes', () => {
    expect(workspaceChangeAffectsGalleryFolder('photos', ['photos'], undefined)).toBe(true);
  });
});

describe('pickGalleryPathAfterRefresh', () => {
  const paths = ['photos/a.png', 'photos/b.png', 'photos/c.png'];

  it('keeps the current path when still present', () => {
    expect(pickGalleryPathAfterRefresh(paths, 'photos/b.png', 1)).toBe('photos/b.png');
  });

  it('picks a nearby sibling when the current path was removed', () => {
    const remaining = ['photos/a.png', 'photos/c.png'];
    expect(pickGalleryPathAfterRefresh(remaining, 'photos/b.png', 1)).toBe('photos/c.png');
  });

  it('clamps to the last sibling when the removed index was at the end', () => {
    const remaining = ['photos/a.png', 'photos/b.png'];
    expect(pickGalleryPathAfterRefresh(remaining, 'photos/c.png', 2)).toBe('photos/b.png');
  });

  it('returns null for an empty gallery', () => {
    expect(pickGalleryPathAfterRefresh([], 'photos/a.png', 0)).toBeNull();
  });
});
