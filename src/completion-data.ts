import { readFileSync, writeFileSync } from 'node:fs';

import { apiGet } from './http';
import { ensureDir, homePath } from './paths';

/**
 * Dynamic shell-completion candidates (supplement slugs, goal ids). Fetched from
 * the public API and cached on disk so a TAB press is instant after the first
 * warm-up. Completion must never hang a shell, so the cold fetch runs under a
 * tight per-request budget and ANY failure degrades to "no suggestions" rather
 * than blocking. See [complete.ts](complete.ts).
 */

export type CandidateKind = 'supplements' | 'goals';

/** 24h — these lists barely change; a stale completion list is harmless. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-request budget for a TAB-time cold fetch. Kept tight so completion never
 * stalls a shell; override with SUPSTACK_COMPLETE_TIMEOUT (ms). The explicit
 * `completion refresh` passes its own, more generous, budget.
 */
function completeTimeoutMs(): number {
  const raw = process.env.SUPSTACK_COMPLETE_TIMEOUT;
  const ms = raw ? Number(raw) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 2500;
}

function cacheFile(kind: CandidateKind): string {
  return homePath('completion', `${kind}.json`);
}

interface CandidateCache {
  ts: number;
  values: string[];
}

function readDisk(kind: CandidateKind): CandidateCache | null {
  try {
    return JSON.parse(readFileSync(cacheFile(kind), 'utf8')) as CandidateCache;
  } catch {
    return null;
  }
}

function writeDisk(kind: CandidateKind, values: string[], now: number): void {
  try {
    ensureDir(homePath('completion'));
    writeFileSync(cacheFile(kind), JSON.stringify({ ts: now, values } satisfies CandidateCache));
  } catch {
    // Best-effort; a failed write just means we refetch next time.
  }
}

/** Fetch every supplement slug, paginating the 50-cap `/supplements` endpoint. */
export async function fetchSupplementSlugs(
  fetchImpl?: typeof fetch,
  timeoutMs = completeTimeoutMs(),
): Promise<string[]> {
  const get = (page: number): Promise<{ data: { slug: string }[]; meta?: { totalPages?: number } }> =>
    apiGet('/supplements', {
      query: { pageSize: 50, page },
      fetchImpl,
      cache: false,
      timeoutMs,
      maxRetries: 0,
    });

  const first = await get(1);
  const slugs = first.data.map((d) => d.slug);
  const totalPages = Math.min(first.meta?.totalPages ?? 1, 20); // hard cap: never paginate unbounded
  if (totalPages > 1) {
    const rest = await Promise.all(Array.from({ length: totalPages - 1 }, (_, i) => get(i + 2)));
    for (const page of rest) for (const d of page.data) slugs.push(d.slug);
  }
  return [...new Set(slugs)].sort();
}

/** Fetch every goal id from the public `/goals` endpoint. */
export async function fetchGoalIds(
  fetchImpl?: typeof fetch,
  timeoutMs = completeTimeoutMs(),
): Promise<string[]> {
  const res = await apiGet<{ data: { id: string }[] }>('/goals', {
    fetchImpl,
    cache: false,
    timeoutMs,
    maxRetries: 0,
  });
  return res.data.map((g) => g.id).sort();
}

function fetcherFor(
  kind: CandidateKind,
): (fetchImpl?: typeof fetch, timeoutMs?: number) => Promise<string[]> {
  return kind === 'supplements' ? fetchSupplementSlugs : fetchGoalIds;
}

/**
 * Resolve completion candidates for `kind`: a fresh disk cache short-circuits;
 * otherwise fetch (best-effort, bounded), persist, and return. On ANY failure
 * fall back to the stale cache if present, else an empty list — completion must
 * never throw or block. `now`/`fetchImpl` are injectable for tests.
 */
export async function loadCandidates(
  kind: CandidateKind,
  opts: { now?: number; fetchImpl?: typeof fetch; force?: boolean; timeoutMs?: number } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const disk = readDisk(kind);
  if (!opts.force && disk && now - disk.ts <= TTL_MS) return disk.values;
  try {
    const values = await fetcherFor(kind)(opts.fetchImpl, opts.timeoutMs);
    writeDisk(kind, values, now);
    return values;
  } catch {
    return disk?.values ?? []; // serve stale on a failed refresh
  }
}

/**
 * Force-refresh both candidate caches (used by `supstack completion refresh`).
 * Returns the count fetched per kind. Best-effort: a failed kind reports 0.
 */
export async function warmCompletionCache(fetchImpl?: typeof fetch): Promise<Record<CandidateKind, number>> {
  // Explicit user action — use a generous budget so it reliably warms even on a
  // cold TLS connection (the TAB-time path stays tight).
  const timeoutMs = 10_000;
  const kinds: CandidateKind[] = ['supplements', 'goals'];
  const counts = await Promise.all(
    kinds.map((k) => loadCandidates(k, { fetchImpl, force: true, timeoutMs }).then((v) => v.length)),
  );
  return { supplements: counts[0] ?? 0, goals: counts[1] ?? 0 };
}
