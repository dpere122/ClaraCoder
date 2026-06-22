import path = require('path');
import { describe, expect, it } from 'vitest';
import { isPathStrictlyInside, validateWorkspaceEntryMove } from './workspace-entry-transfer';

describe('validateWorkspaceEntryMove', () => {
  const root = path.resolve('/workspace');
  const srcFile = path.join(root, 'a.txt');
  const srcDir = path.join(root, 'src');
  const nested = path.join(root, 'src', 'lib');

  it('allows move into sibling folder', () => {
    expect(validateWorkspaceEntryMove(srcFile, path.join(root, 'docs'))).toBeNull();
  });

  it('rejects moving folder into itself', () => {
    expect(validateWorkspaceEntryMove(srcDir, srcDir)).toBe('Cannot move a folder into itself.');
  });

  it('rejects moving folder into descendant', () => {
    expect(validateWorkspaceEntryMove(srcDir, nested)).toBe('Cannot move a folder into its own subfolder.');
  });

  it('allows no-op when destination matches source', () => {
    expect(validateWorkspaceEntryMove(srcFile, root)).toBeNull();
  });
});

describe('isPathStrictlyInside', () => {
  it('detects nested paths', () => {
    const parent = path.resolve('/workspace/src');
    const child = path.resolve('/workspace/src/lib');
    expect(isPathStrictlyInside(parent, child)).toBe(true);
    expect(isPathStrictlyInside(child, parent)).toBe(false);
  });
});
