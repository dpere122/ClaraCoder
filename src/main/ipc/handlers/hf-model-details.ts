/**
 * Hugging Face repo details for the Model Manager panel: repo metadata from ``/api/models/{id}``
 * plus the public profiles of the uploader and the base model's provider. Avatars are fetched here
 * and inlined as ``data:`` URLs because the renderer CSP does not allow remote images.
 */
import type { HuggingFaceModelDetails, HuggingFaceOwnerInfo } from '../../../shared';

const HF_ORIGIN = 'https://huggingface.co';
const AVATAR_HOSTS = new Set(['cdn-avatars.huggingface.co', 'huggingface.co']);
const AVATAR_MAX_BYTES = 256 * 1024;

type Fetch = typeof fetch;

/** ``org/name`` with both parts URL-encoded, keeping the separating slash. */
export function hfRepoPath(repoId: string): string | null {
  const id = repoId.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(id)) {
    return null;
  }
  const [org, repo] = id.split('/') as [string, string];
  return `${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** ``base_model`` card entries; falls back to ``base_model:…`` tags when the card has none. */
function baseModelsOf(raw: Record<string, unknown>, tags: string[]): string[] {
  const card = (raw['cardData'] ?? {}) as Record<string, unknown>;
  const fromCard = card['base_model'];
  const list = Array.isArray(fromCard) ? fromCard.map(str) : [str(fromCard)];
  const out = list.filter((id) => id.includes('/'));
  if (out.length) {
    return [...new Set(out)];
  }
  const fromTags = tags
    .filter((t) => t.startsWith('base_model:') && !/^base_model:(quantized|finetune|adapter|merge):/.test(t))
    .map((t) => t.slice('base_model:'.length));
  return [...new Set(fromTags.filter((id) => id.includes('/')))];
}

/** Map ``/api/models/{id}`` JSON to panel fields. Owners are filled in separately. */
export function parseHfModelDetails(raw: unknown, repoId: string): HuggingFaceModelDetails {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tags = Array.isArray(r['tags']) ? r['tags'].map(str).filter(Boolean) : [];
  const card = (r['cardData'] ?? {}) as Record<string, unknown>;
  const gguf = (r['gguf'] ?? {}) as Record<string, unknown>;
  const licenseTag = tags.find((t) => t.startsWith('license:'));
  return {
    id: str(r['id']) || repoId,
    author: str(r['author']) || repoId.split('/')[0] || '',
    downloads: num(r['downloads']) ?? 0,
    likes: num(r['likes']) ?? 0,
    createdAt: str(r['createdAt']),
    lastModified: str(r['lastModified']),
    license: str(card['license']) || (licenseTag ? licenseTag.slice('license:'.length) : ''),
    baseModels: baseModelsOf(r, tags),
    pipelineTag: str(r['pipeline_tag']),
    architecture: str(gguf['architecture']),
    parameterCount: num(gguf['total']),
    contextLength: num(gguf['context_length']),
    storageBytes: num(r['usedStorage']),
    gated: r['gated'] !== false && r['gated'] != null,
    private: r['private'] === true,
    // Hub bookkeeping tags carry no information for the panel.
    tags: tags.filter((t) => !/^(base_model:|license:|region:|endpoints_compatible$|gguf$)/.test(t)),
    uploader: null,
    provider: null,
  };
}

/** Map an org/user ``overview`` JSON to an owner profile (avatar not yet inlined). */
export function parseHfOwner(raw: unknown, name: string, kind: 'org' | 'user'): HuggingFaceOwnerInfo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    name: str(r['name']) || name,
    fullname: str(r['fullname']) || name,
    kind,
    avatarDataUrl: null,
    verified: r['isVerified'] === true,
    numModels: num(r['numModels']),
    numFollowers: num(r['numFollowers']),
    details: str(r['details']),
  };
}

async function fetchAvatarDataUrl(url: string, fetchImpl: Fetch): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url, HF_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !AVATAR_HOSTS.has(parsed.hostname)) {
    return null;
  }
  try {
    const res = await fetchImpl(parsed.toString(), { headers: { 'User-Agent': 'ClaraCoder-ModelManager' } });
    const type = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > AVATAR_MAX_BYTES ? null : `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// Owner profiles change rarely; keep them for the app session.
const ownerCache = new Map<string, Promise<HuggingFaceOwnerInfo | null>>();

async function loadOwner(name: string, headers: Record<string, string>, fetchImpl: Fetch): Promise<HuggingFaceOwnerInfo | null> {
  const seg = encodeURIComponent(name);
  for (const kind of ['org', 'user'] as const) {
    const url = `${HF_ORIGIN}/api/${kind === 'org' ? 'organizations' : 'users'}/${seg}/overview`;
    try {
      const res = await fetchImpl(url, { headers });
      if (!res.ok) {
        continue;
      }
      const raw = (await res.json()) as Record<string, unknown>;
      const owner = parseHfOwner(raw, name, kind);
      const avatar = str(raw['avatarUrl']);
      owner.avatarDataUrl = avatar ? await fetchAvatarDataUrl(avatar, fetchImpl) : null;
      return owner;
    } catch {
      // Try the other kind, then give up quietly: owner info is decoration.
    }
  }
  return null;
}

function ownerInfo(name: string, headers: Record<string, string>, fetchImpl: Fetch): Promise<HuggingFaceOwnerInfo | null> {
  const key = name.toLowerCase();
  let hit = ownerCache.get(key);
  if (!hit) {
    hit = loadOwner(name, headers, fetchImpl);
    ownerCache.set(key, hit);
    // Don't pin a failed lookup for the whole session.
    void hit.then((v) => (v ? undefined : ownerCache.delete(key)));
  }
  return hit;
}

/** Repo details plus uploader / provider profiles. Throws with a user-facing message on failure. */
export async function fetchHfModelDetails(
  repoId: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<HuggingFaceModelDetails> {
  const repoPath = hfRepoPath(repoId);
  if (!repoPath) {
    throw new Error('Invalid Hugging Face repo id.');
  }
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'ClaraCoder-ModelManager' };
  const authed = token.trim() ? { ...headers, Authorization: `Bearer ${token.trim()}` } : headers;
  const res = await fetchImpl(`${HF_ORIGIN}/api/models/${repoPath}`, { headers: authed });
  if (!res.ok) {
    throw new Error(`Hugging Face repo lookup failed (${res.status}).`);
  }
  const details = parseHfModelDetails(await res.json(), repoId.trim());
  const providerName = details.baseModels[0]?.split('/')[0] ?? '';
  // Profiles are public: never send the token along with them.
  const [uploader, provider] = await Promise.all([
    details.author ? ownerInfo(details.author, headers, fetchImpl) : Promise.resolve(null),
    providerName && providerName.toLowerCase() !== details.author.toLowerCase()
      ? ownerInfo(providerName, headers, fetchImpl)
      : Promise.resolve(null),
  ]);
  return { ...details, uploader, provider };
}

/** Test hook: forget cached owner profiles. */
export function clearHfOwnerCacheForTests(): void {
  ownerCache.clear();
}
