/** Detect typical Python project files in bounded workspace tree text (``buildWorkspaceTree`` output). */
export function workspaceTreeTextHintsPython(tree: string): boolean {
  const raw = tree.trim();
  if (!raw) {
    return false;
  }
  const tl = raw.toLowerCase();
  const markers = [
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'requirements.in',
    'pipfile',
    'poetry.lock',
    'pdm.lock',
    'uv.lock',
    'manage.py',
    'tox.ini',
    'environment.yml',
    'environment.yaml',
    'conda.yml',
    'conda.yaml',
    '.python-version',
    'pyrightconfig.json',
    'ruff.toml',
    '.ruff.toml',
    'pytest.ini',
    'mypy.ini',
    '.flake8',
    'pixi.toml',
  ];
  for (const m of markers) {
    if (tl.includes(m)) {
      return true;
    }
  }
  return /[^\s|'"`]+\.(?:py|pyi)(?:\s|$|\n|\[)/.test(raw);
}
