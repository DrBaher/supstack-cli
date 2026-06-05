import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDir, homePath } from './paths';

/** Default TTL — matches the API's `s-maxage=3600` on evidence endpoints. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Hard cap on cached response files. Beyond this, the oldest are pruned on write. */
const MAX_CACHE_ENTRIES = 500;

function cacheDir(): string {
  return homePath('cache');
}

/** The configured TTL in ms (override with SUPSTACK_CACHE_TTL, in seconds). */
export function cacheTtlMs(): number {
  const raw = process.env.SUPSTACK_CACHE_TTL;
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : DEFAULT_TTL_MS;
}

/**
 * Whether the response cache is active. Off when explicitly disabled
 * (SUPSTACK_NO_CACHE / `--no-cache`) and off under vitest so unit tests with a
 * mocked `fetch` never read/write a real cache file. `force` overrides both
 * (used by the cache's own tests).
 */
export function cacheEnabled(force?: boolean): boolean {
  if (force !== undefined) return force;
  if (process.env.SUPSTACK_NO_CACHE) return false;
  if (process.env.VITEST) return false;
  return true;
}

/**
 * Cache key for a request. The optional `identity` segregates entries by who is
 * asking: anonymous responses and per-key responses for the same URL must never
 * share a slot. Today the public API is key-independent, but Phase 2 auth will
 * return per-user data — folding the identity in now prevents a future
 * cross-account cache-bleed without a key-format migration.
 */
export function cacheKeyFor(url: string, identity = 'anon'): string {
  return createHash('sha1').update(`${identity}\n${url}`).digest('hex');
}

/** Short, non-reversible fingerprint of an API key for use as a cache identity. */
export function cacheIdentityFor(apiKey?: string): string {
  if (!apiKey) return 'anon';
  return 'k_' + createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

interface CacheEntry {
  url: string;
  ts: number;
  body: unknown;
}

/** Return the cached body if present and within `ttlMs`, else undefined. */
export function readCache(key: string, ttlMs: number, now: number): unknown | undefined {
  try {
    const entry = JSON.parse(readFileSync(join(cacheDir(), `${key}.json`), 'utf8')) as CacheEntry;
    if (now - entry.ts > ttlMs) return undefined;
    return entry.body;
  } catch {
    return undefined;
  }
}

export function writeCache(key: string, url: string, body: unknown, now: number): void {
  try {
    ensureDir(cacheDir());
    const entry: CacheEntry = { url, ts: now, body };
    writeFileSync(join(cacheDir(), `${key}.json`), JSON.stringify(entry));
    pruneCache();
  } catch {
    // Cache writes are best-effort; a failure must never break a command.
  }
}

/**
 * Bound the on-disk cache. Stale entries are only dropped lazily on read, so a
 * long-lived install accumulating many distinct lookups would grow without
 * limit. When the file count exceeds the cap, evict the oldest by mtime.
 */
function pruneCache(): void {
  try {
    const dir = cacheDir();
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length <= MAX_CACHE_ENTRIES) return;
    const byAge = files
      .map((f) => {
        const p = join(dir, f);
        return { p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const { p } of byAge.slice(0, byAge.length - MAX_CACHE_ENTRIES)) {
      rmSync(p, { force: true });
    }
  } catch {
    // Pruning is best-effort housekeeping; never let it break a write.
  }
}

/** Delete every cached response. Returns the number of files removed. */
export function clearCache(): number {
  try {
    const dir = cacheDir();
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) rmSync(join(dir, f));
    return files.length;
  } catch {
    return 0;
  }
}

export function cachePath(): string {
  return cacheDir();
}
