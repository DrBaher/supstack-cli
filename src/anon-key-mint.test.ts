import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The anonymous-key mint in resolveApiKey (src/http.ts). It is skipped under
 * vitest, so these tests blank VITEST and load a fresh module per test (the mint
 * keeps per-process state).
 *
 * The defect these hold closed (found 10 Nov 2026 in production): on a read-only
 * home the save threw inside the mint's try, so the minted key was discarded,
 * the read went out unkeyed, and the next read minted again. Three outside IPs
 * left four never-used "CLI (anonymous)" rows in api_keys that way in 5 minutes.
 */

const BASE = 'https://example.test/api/v1';
let scratch: string;

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that mints sk_live_minted_<n> and answers every other path with data. */
function fakeApi(opts: { mintDelayMs?: number } = {}) {
  let mints = 0;
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/auth/anon-token')) {
      mints += 1;
      const n = mints;
      if (opts.mintDelayMs) await new Promise((r) => setTimeout(r, opts.mintDelayMs));
      return json({ key: `sk_live_minted_${n}` });
    }
    return json({ data: { ok: true } });
  });
  const keysSent = () =>
    fetchImpl.mock.calls
      .filter(([url]) => !String(url).endsWith('/auth/anon-token'))
      .map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      .map((h) => h['X-API-Key']);
  const mintCount = () => mints;
  return { fetchImpl: fetchImpl as unknown as typeof fetch, keysSent, mintCount };
}

async function loadHttp() {
  vi.resetModules();
  return import('./http');
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'supstack-anon-'));
  vi.stubEnv('VITEST', '');
  vi.stubEnv('SUPSTACK_API_URL', BASE);
  vi.stubEnv('SUPSTACK_API_KEY', undefined as unknown as string);
  vi.stubEnv('SUPSTACK_NO_ANON_TOKEN', undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('anonymous key mint', () => {
  it('mints once, persists the key, and sends it on every read', async () => {
    const home = join(scratch, 'home');
    vi.stubEnv('SUPSTACK_HOME', home);
    const { apiGet } = await loadHttp();
    const api = fakeApi();

    await apiGet('/definitions', { fetchImpl: api.fetchImpl, baseUrl: BASE });
    await apiGet('/goals', { fetchImpl: api.fetchImpl, baseUrl: BASE });

    expect(api.mintCount()).toBe(1);
    expect(api.keysSent()).toEqual(['sk_live_minted_1', 'sk_live_minted_1']);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).anonKey).toBe('sk_live_minted_1');
  });

  it('keeps the minted key for the process when the home cannot be written', async () => {
    // A regular file where the home directory should be: mkdir fails with ENOTDIR,
    // which holds even when the tests run as root (a chmod'd dir would not).
    const blocker = join(scratch, 'not-a-dir');
    writeFileSync(blocker, '');
    vi.stubEnv('SUPSTACK_HOME', join(blocker, 'home'));
    const { apiGet } = await loadHttp();
    const api = fakeApi();

    await apiGet('/definitions', { fetchImpl: api.fetchImpl, baseUrl: BASE });
    await apiGet('/definitions', { fetchImpl: api.fetchImpl, baseUrl: BASE });
    await apiGet('/goals', { fetchImpl: api.fetchImpl, baseUrl: BASE });

    expect(api.mintCount()).toBe(1);
    expect(api.keysSent()).toEqual(['sk_live_minted_1', 'sk_live_minted_1', 'sk_live_minted_1']);
  });

  it('shares one mint between concurrent first reads', async () => {
    vi.stubEnv('SUPSTACK_HOME', join(scratch, 'home'));
    const { apiGet } = await loadHttp();
    const api = fakeApi({ mintDelayMs: 20 });

    await Promise.all(
      ['/a', '/b', '/c', '/d'].map((p) => apiGet(p, { fetchImpl: api.fetchImpl, baseUrl: BASE })),
    );

    expect(api.mintCount()).toBe(1);
    expect(api.keysSent()).toEqual(Array(4).fill('sk_live_minted_1'));
  });

  it('backs off after a failed mint and reads unkeyed', async () => {
    vi.stubEnv('SUPSTACK_HOME', join(scratch, 'home'));
    const { apiGet } = await loadHttp();
    let mintCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/anon-token')) {
        mintCalls += 1;
        throw new Error('offline');
      }
      return json({ data: { ok: true } });
    }) as unknown as typeof fetch;

    await apiGet('/a', { fetchImpl, baseUrl: BASE });
    await apiGet('/b', { fetchImpl, baseUrl: BASE });

    expect(mintCalls).toBe(1); // the second read is inside the 60 s cooldown
  });
});
