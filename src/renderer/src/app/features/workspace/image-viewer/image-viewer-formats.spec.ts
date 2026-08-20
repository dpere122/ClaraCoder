import { describe, expect, it } from 'vitest';
import { isViewableImagePath, viewableImageExtension } from './image-viewer-formats';

describe('viewableImageExtension', () => {
  it('returns the last dotted suffix', () => {
    expect(viewableImageExtension('photos/a.PNG')).toBe('.png');
    expect(viewableImageExtension('a.b.svg')).toBe('.svg');
  });

  it('returns empty for names with no extension and Unix hidden files', () => {
    expect(viewableImageExtension('README')).toBe('');
    expect(viewableImageExtension('.project')).toBe('');
    expect(viewableImageExtension('.classpath')).toBe('');
    expect(viewableImageExtension('src/.gitignore')).toBe('');
  });

  it('still finds a real extension on hidden files', () => {
    expect(viewableImageExtension('.hidden.png')).toBe('.png');
  });
});

describe('isViewableImagePath', () => {
  it('accepts viewer-supported image extensions', () => {
    expect(isViewableImagePath('a.png')).toBe(true);
    expect(isViewableImagePath('icons/app.ico')).toBe(true);
    expect(isViewableImagePath('diagram.SVG')).toBe(true);
  });

  it('rejects Eclipse metadata and other non-images', () => {
    expect(isViewableImagePath('.project')).toBe(false);
    expect(isViewableImagePath('.classpath')).toBe(false);
    expect(isViewableImagePath('src/Main.java')).toBe(false);
    expect(isViewableImagePath('README')).toBe(false);
  });
});
