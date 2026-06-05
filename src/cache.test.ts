import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheIdentityFor, cacheKeyFor, clearCache, readCache, writeCache } from './cache';
import { apiGet } from './http';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-cache-'));
  process.env.SUPSTACK_HOME = home;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('cache store', () => {
  it('returns a fresh entry and expires a stale one', () => {
    const key = cacheKeyFor('https://x/y');
    writeCache(key, 'https://x/y', { hello: 1 }, 1_000);
    expect(readCache(key, 5_000, 3_000)).toEqual({ hello: 1 }); // 2s old, ttl 5s → hit
    expect(readCache(key, 5_000, 9_000)).toBeUndefined(); // 8s old, ttl 5s → miss
  });

  it('clearCache removes all entries', () => {
    writeCache(cacheKeyFor('a'), 'a', 1, 0);
    writeCache(cacheKeyFor('b'), 'b', 2, 0);
    expect(clearCache()).toBe(2);
    expect(clearCache()).toBe(0);
  });

  it('prunes the oldest entries once the cap is exceeded', () => {
    // Cap is 500; write 520 entries with strictly increasing mtimes so the
    // oldest are deterministically evictable, then confirm we settle at the cap.
    const total = 520;
    for (let i = 0; i < total; i++) {
      writeCache(cacheKeyFor(`url-${i}`), `url-${i}`, i, i);
    }
    const remaining = clearCache(); // returns how many files it deleted = current count
    expect(remaining).toBe(500);
  });

  it('segregates cache keys by identity (no cross-account bleed)', () => {
    const url = 'https://x/y';
    const anon = cacheKeyFor(url, cacheIdentityFor(undefined));
    const userA = cacheKeyFor(url, cacheIdentityFor('key_aaa'));
    const userB = cacheKeyFor(url, cacheIdentityFor('key_bbb'));
    expect(new Set([anon, userA, userB]).size).toBe(3); // all distinct
    expect(cacheIdentityFor(undefined)).toBe('anon');
    expect(cacheIdentityFor('key_aaa')).toBe(cacheIdentityFor('key_aaa')); // stable
    expect(cacheIdentityFor('key_aaa')).not.toContain('key_aaa'); // not the raw key
  });
});

describe('apiGet read-through cache', () => {
  it('serves the second identical call from cache (one fetch)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ data: 42 }));
    const opts = { fetchImpl, cache: true, baseUrl: 'https://example.test/api/v1' } as const;

    const a = await apiGet('/thing', opts);
    const b = await apiGet('/thing', opts);

    expect(a).toEqual({ data: 42 });
    expect(b).toEqual({ data: 42 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second call hit the cache
  });

  it('does not cache when disabled', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ data: 1 }));
    const opts = { fetchImpl, cache: false, baseUrl: 'https://example.test/api/v1' } as const;

    await apiGet('/thing2', opts);
    await apiGet('/thing2', opts);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
