/** Env var names withheld from integrated shells and script children. */
const BLOCKED_ENV_KEYS = new Set(
  [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'HF_TOKEN',
    'HUGGINGFACE_HUB_TOKEN',
    'HUGGING_FACE_HUB_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ].map((k) => k.toUpperCase()),
);

/** Copy parent env for child shells, omitting common secret-bearing variables. */
export function envForChildProcess(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
      continue;
    }
    env[key] = value;
  }
  if (!env.PYTHONIOENCODING?.trim()) {
    env.PYTHONIOENCODING = 'utf-8';
  }
  if (!env.PYTHONUTF8?.trim()) {
    env.PYTHONUTF8 = '1';
  }
  if (!env.TERM?.trim()) {
    env.TERM = 'xterm-256color';
  }
  if (!env.FORCE_COLOR?.trim()) {
    env.FORCE_COLOR = '1';
  }
  if (!env.PY_COLORS?.trim()) {
    env.PY_COLORS = '1';
  }
  delete env.NO_COLOR;
  return env;
}
