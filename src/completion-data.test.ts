import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchGoalIds, fetchSupplementSlugs, loadCandidates, warmCompletionCache } from './completion-data';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** A fetch mock that answers /supplements (paginated) and /goals. */
function apiMock(): ReturnType<typeof vi.fn> {
  return vi.fn((input: string) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith('/supplements')) {
      const page = Number(u.searchParams.get('page'));
      const body =
        page === 1
          ? { data: [{ slug: 'magnesium' }, { slug: 'creatine' }], meta: { totalPages: 2 } }
          : { data: [{ slug: 'zinc' }], meta: { totalPages: 2 } };
      return Promise.resolve(jsonRes(body));
    }
    if (u.pathname.endsWith('/goals')) {
      return Promise.resolve(jsonRes({ data: [{ id: 'focus' }, { id: 'deep-sleep' }] }));
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'nope' }) } as Response);
  });
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-comp-'));
  process.env.SUPSTACK_HOME = home;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('completion-data', () => {
  it('fetchSupplementSlugs paginates and sorts/dedupes', async () => {
    const slugs = await fetchSupplementSlugs(apiMock() as unknown as typeof fetch);
    expect(slugs).toEqual(['creatine', 'magnesium', 'zinc']);
  });

  it('fetchGoalIds returns sorted ids', async () => {
    const ids = await fetchGoalIds(apiMock() as unknown as typeof fetch);
    expect(ids).toEqual(['deep-sleep', 'focus']);
  });

  it('loadCandidates fetches on a cold cache, then serves the warm cache', async () => {
    const fetchImpl = apiMock();
    const first = await loadCandidates('goals', {
      now: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(first).toEqual(['deep-sleep', 'focus']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Same (still-fresh) cache → no second fetch.
    const second = await loadCandidates('goals', {
      now: 2000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second).toEqual(['deep-sleep', 'focus']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('loadCandidates serves a stale cache when the refresh fails', async () => {
    const ok = apiMock();
    await loadCandidates('goals', { now: 0, fetchImpl: ok as unknown as typeof fetch });

    // 25h later (past the 24h TTL) the refresh throws → fall back to the stale list.
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    const stale = await loadCandidates('goals', {
      now: 25 * 60 * 60 * 1000,
      fetchImpl: failing as unknown as typeof fetch,
    });
    expect(stale).toEqual(['deep-sleep', 'focus']);
    expect(failing).toHaveBeenCalled();
  });

  it('loadCandidates returns [] when a cold fetch fails with no cache', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    const out = await loadCandidates('supplements', {
      now: 0,
      fetchImpl: failing as unknown as typeof fetch,
    });
    expect(out).toEqual([]);
  });

  it('warmCompletionCache reports counts for both kinds', async () => {
    const counts = await warmCompletionCache(apiMock() as unknown as typeof fetch);
    expect(counts).toEqual({ supplements: 3, goals: 2 });
  });
});
