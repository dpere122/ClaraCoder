/**
 * ``fetch`` that honors ``HTTP(S)_PROXY`` / ``NO_PROXY``, as the Python backend's httpx clients do.
 * Node's global fetch ignores them, so without this main could call a provider unreachable on a
 * network the backend sends through just fine.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

let agent: EnvHttpProxyAgent | null | undefined;

function proxyAgent(): EnvHttpProxyAgent | null {
  if (agent === undefined) {
    const { http_proxy, HTTP_PROXY, https_proxy, HTTPS_PROXY } = process.env;
    agent = http_proxy || HTTP_PROXY || https_proxy || HTTPS_PROXY ? new EnvHttpProxyAgent() : null;
  }
  return agent;
}

/** Test hook: read the proxy variables again on the next request. */
export function resetEnvProxyForTests(): void {
  agent = undefined;
}

export const envProxyFetch: typeof fetch = (input, init) => {
  const dispatcher = proxyAgent();
  if (!dispatcher) {
    return fetch(input, init);
  }
  return undiciFetch(input as never, { ...init, dispatcher } as never) as unknown as Promise<Response>;
};
