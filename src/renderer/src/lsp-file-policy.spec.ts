import { lspServerKindForWorkspaceRelativePath } from '@shared/lsp-file-policy';

describe('lspServerKindForWorkspaceRelativePath', () => {
  it('normalizes backslashes', () => {
    expect(lspServerKindForWorkspaceRelativePath('src\\foo\\bar.py')).toBe('python');
  });

  it('returns python for .py', () => {
    expect(lspServerKindForWorkspaceRelativePath('pkg/mod.py')).toBe('python');
  });

  it('returns typescript for TS/JS extensions', () => {
    expect(lspServerKindForWorkspaceRelativePath('app.tsx')).toBe('typescript');
    expect(lspServerKindForWorkspaceRelativePath('x.mjs')).toBe('typescript');
  });

  it('returns gdscript for .gd', () => {
    expect(lspServerKindForWorkspaceRelativePath('game/Main.gd')).toBe('gdscript');
  });

  it('returns java for .java', () => {
    expect(lspServerKindForWorkspaceRelativePath('src/main/java/App.java')).toBe('java');
  });

  it('returns null for unsupported extensions', () => {
    expect(lspServerKindForWorkspaceRelativePath('readme.md')).toBeNull();
    expect(lspServerKindForWorkspaceRelativePath('')).toBeNull();
  });
});
