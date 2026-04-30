/**
 * Heuristics for llama.cpp ``llama-server`` pulling a remote model (e.g. ``-hf``) before ``/health`` is ready.
 */

/** True when the managed shell command likely triggers a Hugging Face (or similar) model fetch. */
export function managedLlamaCmdUsesHfRemoteModel(cmd: string): boolean {
  const t = cmd.trim();
  if (!t) {
    return false;
  }
  return /\s-hf(\s|$)|\s--hf-url(\s|=)/i.test(t);
}

/**
 * Inspect recent process output for download / fetch activity.
 * Intentionally broad so locale and minor log wording changes still match.
 */
export function looksLikeLlamaModelDownload(logTail: string): boolean {
  const s = logTail.toLowerCase();
  if (!s.trim()) {
    return false;
  }
  if (/\bdownloading\b/.test(s) && (s.includes('model') || s.includes('gguf') || s.includes('shard') || s.includes('%'))) {
    return true;
  }
  if (s.includes('huggingface.co') || s.includes('hf.co/')) {
    if (s.includes('download') || s.includes('fetch') || s.includes('http') || s.includes('curl') || s.includes('get ')) {
      return true;
    }
  }
  if (s.includes('huggingface_hub') || s.includes('hf_hub')) {
    return true;
  }
  if (s.includes('fetching') && (s.includes('model') || s.includes('gguf') || s.includes('weights'))) {
    return true;
  }
  if (s.includes('curl') && (s.includes('huggingface') || s.includes('hf.co'))) {
    return true;
  }
  if (s.includes('resolving') && s.includes('revision')) {
    return true;
  }
  if (s.includes('common_download_file_single_online')) {
    return true;
  }
  if (s.includes('no previous model file found') && (s.includes('.gguf') || s.includes('.ini') || s.includes('preset'))) {
    return true;
  }
  return false;
}
