/** A curated Hugging Face GGUF repo shown before the user searches. */
export interface FeaturedHfModel {
  /** Repo id, e.g. ``unsloth/Qwen3.8-27B-GGUF``. */
  id: string;
  /** Who trained the base model (the repo owner is usually the quantizer). */
  maker: string;
  /** Short size / architecture note, e.g. ``35B MoE · 3B active``. */
  size: string;
  tag: 'General' | 'Coding' | 'Reasoning' | 'Small';
  architecture: 'dense' | 'moe';
  /** Approximate language-model parameter counts in billions, as reported by the model provider. */
  totalParametersB: number;
  /** Active parameters per token; for a dense model this is its reported total. */
  activeParametersB: number;
}

/**
 * Parameter counts refer to the base language model, not a GGUF's byte size.
 * https://huggingface.co/Qwen/Qwen3.8-27B
 * https://huggingface.co/Qwen/Qwen3.6-35B-A3B
 * https://huggingface.co/Qwen/Qwen3.5-9B
 * https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct
 * https://huggingface.co/google/gemma-4-26B-A4B-it
 * https://huggingface.co/openai/gpt-oss-20b
 */
export const FEATURED_HF_MODELS: readonly FeaturedHfModel[] = [
  { id: 'unsloth/Qwen3.8-27B-GGUF', maker: 'Qwen', size: '27B dense', tag: 'General', architecture: 'dense', totalParametersB: 27, activeParametersB: 27 },
  { id: 'unsloth/Qwen3.6-35B-A3B-GGUF', maker: 'Qwen', size: '35B MoE · 3B active', tag: 'General', architecture: 'moe', totalParametersB: 35, activeParametersB: 3 },
  { id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', maker: 'Qwen', size: '30.5B MoE · 3.3B active', tag: 'Coding', architecture: 'moe', totalParametersB: 30.5, activeParametersB: 3.3 },
  { id: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF', maker: 'Mistral', size: '24B dense', tag: 'Coding', architecture: 'dense', totalParametersB: 24, activeParametersB: 24 },
  { id: 'ggml-org/gpt-oss-20b-GGUF', maker: 'OpenAI', size: '21B MoE · 3.6B active', tag: 'Reasoning', architecture: 'moe', totalParametersB: 21, activeParametersB: 3.6 },
  { id: 'unsloth/gemma-4-26B-A4B-it-GGUF', maker: 'Google', size: '25.2B MoE · 3.8B active', tag: 'General', architecture: 'moe', totalParametersB: 25.2, activeParametersB: 3.8 },
  { id: 'unsloth/gemma-4-12b-it-GGUF', maker: 'Google', size: '12B dense', tag: 'Small', architecture: 'dense', totalParametersB: 11.95, activeParametersB: 11.95 },
  { id: 'unsloth/Qwen3.5-9B-GGUF', maker: 'Qwen', size: '9B dense', tag: 'Small', architecture: 'dense', totalParametersB: 9, activeParametersB: 9 },
];

/** Choose tutorial examples by total parameters, not the display note or MoE active count. */
export function featuredModelExamples(models: readonly FeaturedHfModel[]): {
  small: FeaturedHfModel | null;
  largest: FeaturedHfModel | null;
} {
  let small: FeaturedHfModel | null = null;
  let largest: FeaturedHfModel | null = null;
  for (const model of models) {
    if (
      !Number.isFinite(model.totalParametersB) || model.totalParametersB <= 0 ||
      !Number.isFinite(model.activeParametersB) || model.activeParametersB <= 0 ||
      model.activeParametersB > model.totalParametersB
    ) {
      continue;
    }
    if (!largest || model.totalParametersB > largest.totalParametersB) {
      largest = model;
    }
    if (model.tag === 'Small' && (!small || model.totalParametersB < small.totalParametersB)) {
      small = model;
    }
  }
  return { small, largest };
}

/** ``owner/name`` → ``{ provider: owner, name }`` with a trailing ``-GGUF`` dropped from the name. */
export function splitHfRepoId(id: string): { provider: string; name: string } {
  const trimmed = id.trim();
  const slash = trimmed.indexOf('/');
  const provider = slash > 0 ? trimmed.slice(0, slash) : '';
  const rawName = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  const name = rawName.replace(/[-_.]gguf$/i, '') || rawName;
  return { provider, name };
}

/**
 * Local hub cache folders are named ``models--owner--name``; split those the same way.
 * Returns null for plain GGUF files and folders that don't follow the hub layout.
 */
export function splitHubCacheFolderName(folderName: string): { provider: string; name: string } | null {
  const repoId = hubFolderRepoId(folderName);
  return repoId ? splitHfRepoId(repoId) : null;
}

/** ``hf_••••abcd``: enough to tell tokens apart in the read-only view. */
export function maskHfToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= 8) {
    return '•'.repeat(trimmed.length);
  }
  const prefix = trimmed.startsWith('hf_') ? 'hf_' : '';
  return `${prefix}••••${trimmed.slice(-4)}`;
}

/** ``1234567`` → ``1.2M``; HF download and like counts. */
export function formatHfCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '0';
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(Math.floor(n));
}

/** ISO timestamp → ``Mar 6, 2026``; empty when unparseable. */
export function formatHfDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return '';
  }
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** GGUF parameter count → ``27.3B`` / ``600M``; empty when unknown. */
export function formatHfParams(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) {
    return '';
  }
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1).replace(/\.0$/, '')}B`;
  }
  return `${Math.round(n / 1e6)}M`;
}

/** Context length in tokens → ``262K``; empty when unknown. */
export function formatHfContext(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) {
    return '';
  }
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

/** Repo id for a local ``models--owner--name`` hub folder; null for plain files. */
export function hubFolderRepoId(folderName: string): string | null {
  const m = /^models--(.+?)--(.+)$/.exec(folderName.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
