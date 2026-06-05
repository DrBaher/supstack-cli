import { cacheEnabled, cacheIdentityFor, cacheKeyFor, cacheTtlMs, readCache, writeCache } from './cache';
import { getApiKey, getBaseUrl, saveAnonKey } from './config';
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
  /** Per-attempt timeout in ms. A hung connection aborts and is retried. Default 20s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Per-request timeout in ms. Override with SUPSTACK_TIMEOUT (seconds) / `--timeout`. */
function defaultTimeoutMs(): number {
  const raw = process.env.SUPSTACK_TIMEOUT;
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : DEFAULT_TIMEOUT_MS;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff, capped, in milliseconds. */
function backoffMs(attempt: number): number {
  return Math.min(2000, 250 * 2 ** attempt);
}

/**
 * Parse a `Retry-After` header. Per RFC 7231 it is EITHER a delay in seconds OR
 * an HTTP-date; honour both. Returns the delay in ms, or null if unparseable.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : null;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  const delta = date - now;
  return delta > 0 ? delta : null;
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
  const apiKey = await resolveApiKey(opts.apiKey, opts.fetchImpl);
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();

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
  const cacheKey = useCache ? cacheKeyFor(url.toString(), cacheIdentityFor(apiKey)) : null;
  if (cacheKey) {
    const hit = readCache(cacheKey, cacheTtlMs(), Date.now());
    if (hit !== undefined) return hit as T;
  }

  let attempt = 0;
  for (;;) {
    let res: Response;
    // Abort a hung connection so a stalled request can't block the CLI — or, worse,
    // an MCP agent's tool call — forever. A timeout is retried like a network error.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetchImpl(url.toString(), { headers, signal: controller.signal });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      if (attempt >= maxRetries) {
        throw new ApiError(
          0,
          timedOut ? `Request timed out after ${timeoutMs}ms` : `Network error: ${(err as Error).message}`,
        );
      }
      await sleep(backoffMs(attempt));
      attempt++;
      continue;
    } finally {
      clearTimeout(timer);
    }

    // Transient: retry with backoff (respecting Retry-After).
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        throw new ApiError(res.status, `Request failed after ${maxRetries} retries (HTTP ${res.status})`);
      }
      const wait = parseRetryAfter(res.headers.get('retry-after'), Date.now()) ?? backoffMs(attempt);
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

// ─── Anonymous instant-token (minted on first read) ──────────────────────

let anonMintAttempted = false;

/**
 * Resolve the X-API-Key to send. If none is configured, mint an anonymous
 * instant-token ONCE per process on the first read and persist it — so repeat
 * runs carry a stable per-key identity (better rate limits + visibility) with
 * zero friction. Best-effort: a mint failure (offline, disabled) falls back to
 * anonymous-by-IP. Skipped under vitest and when SUPSTACK_NO_ANON_TOKEN is set.
 */
async function resolveApiKey(explicit?: string, fetchImpl?: typeof fetch): Promise<string | undefined> {
  if (explicit) return explicit;
  const existing = getApiKey();
  if (existing) return existing;
  if (anonMintAttempted || process.env.VITEST || process.env.SUPSTACK_NO_ANON_TOKEN) return undefined;
  anonMintAttempted = true;
  try {
    const res = await apiPost<{ key?: string }>('/auth/anon-token', undefined, { fetchImpl });
    if (res?.key) {
      saveAnonKey(res.key);
      return res.key;
    }
  } catch {
    // Offline / endpoint unavailable — proceed anonymously (by IP).
  }
  return undefined;
}

// ─── POST helper (auth endpoints) ────────────────────────────────────────

export interface ApiPostOptions {
  /** `Authorization: Bearer <token>` for authenticated endpoints. */
  bearer?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * POST a JSON endpoint. Unlike apiGet this does NOT cache or retry — the auth
 * endpoints (device/start, device/token, anon-token, logout) are stateful, so a
 * blind retry could double-issue. A single attempt under a timeout.
 */
export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  opts: ApiPostOptions = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? getBaseUrl();
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `@supstack/cli/${VERSION}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(baseUrl + path, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(
      0,
      controller.signal.aborted
        ? `Request timed out after ${timeoutMs}ms`
        : `Network error: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && ('message' in json || 'error' in json)
        ? String(
            (json as { message?: unknown; error?: unknown }).message ?? (json as { error?: unknown }).error,
          )
        : `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, message, json);
  }
  return json as T;
}

/** GET an authenticated endpoint with a Bearer token (no cache). */
export async function apiGetAuthed<T = unknown>(
  path: string,
  bearer: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? getBaseUrl();
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(baseUrl + path, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `@supstack/cli/${VERSION}`,
        Authorization: `Bearer ${bearer}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(
      0,
      controller.signal.aborted
        ? `Request timed out after ${timeoutMs}ms`
        : `Network error: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && ('message' in json || 'error' in json)
        ? String(
            (json as { message?: unknown; error?: unknown }).message ?? (json as { error?: unknown }).error,
          )
        : `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, message, json);
  }
  return json as T;
}
