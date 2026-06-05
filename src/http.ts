import { cacheEnabled, cacheKeyFor, cacheTtlMs, readCache, writeCache } from './cache';
import { getApiKey, getBaseUrl } from './config';
import { VERSION } from './version';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiGetOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests (so retry backoff doesn't actually sleep). */
  sleepImpl?: (ms: number) => Promise<void>;
  maxRetries?: number;
  apiKey?: string;
  baseUrl?: string;
  /** Force cache on/off for this call (overrides env + the vitest auto-disable). */
  cache?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff, capped, in milliseconds. */
function backoffMs(attempt: number): number {
  return Math.min(2000, 250 * 2 ** attempt);
}

/**
 * GET a JSON endpoint from the SupStack public API.
 *
 * Built-in resilience for the documented 60/min IP rate limit:
 *   - retries on 429 and 5xx with exponential backoff
 *   - respects a `Retry-After` header when present
 *   - surfaces structured `{ error }` bodies as ApiError.message
 */
export async function apiGet<T = unknown>(path: string, opts: ApiGetOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const baseUrl = opts.baseUrl ?? getBaseUrl();
  const apiKey = opts.apiKey ?? getApiKey();
  const maxRetries = opts.maxRetries ?? 3;

  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `@supstack/cli/${VERSION}`,
  };
  if (apiKey) headers['X-API-Key'] = apiKey;

  // Read-through cache: a fresh entry short-circuits the network entirely,
  // which is what keeps repeat lookups under the 60/min IP limit.
  const useCache = cacheEnabled(opts.cache);
  const cacheKey = useCache ? cacheKeyFor(url.toString()) : null;
  if (cacheKey) {
    const hit = readCache(cacheKey, cacheTtlMs(), Date.now());
    if (hit !== undefined) return hit as T;
  }

  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { headers });
    } catch (err) {
      if (attempt >= maxRetries) {
        throw new ApiError(0, `Network error: ${(err as Error).message}`);
      }
      await sleep(backoffMs(attempt));
      attempt++;
      continue;
    }

    // Transient: retry with backoff (respecting Retry-After).
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        throw new ApiError(res.status, `Request failed after ${maxRetries} retries (HTTP ${res.status})`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
      await sleep(wait);
      attempt++;
      continue;
    }

    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const message =
        json && typeof json === 'object' && 'error' in json
          ? String((json as { error: unknown }).error)
          : `Request failed (HTTP ${res.status})`;
      throw new ApiError(res.status, message, json);
    }
    if (cacheKey) writeCache(cacheKey, url.toString(), json, Date.now());
    return json as T;
  }
}
