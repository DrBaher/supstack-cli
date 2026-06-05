import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotLoggedInError } from './cloud-stack';
import { getRecommendations } from './recommend';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-rec-'));
  process.env.SUPSTACK_HOME = home;
  delete process.env.SUPSTACK_TOKEN;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('recommend', () => {
  it('requires a token', async () => {
    await expect(getRecommendations(10)).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('GETs /me/recommend with the Bearer token + limit and returns data', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          recommendations: [
            {
              supplement: {
                id: 'magnesium',
                slug: 'magnesium',
                name: 'Magnesium',
                evidence: { score: 8.5 },
                safety: {},
              },
              scores: { composite: 88 },
              goalBreakdown: [
                { goalId: 'deep-sleep', goalName: 'Deep Sleep', relevanceScore: 95, isPrimaryMatch: true },
              ],
              warnings: [],
            },
          ],
        },
        meta: {
          goals: [{ id: 'deep-sleep', name: 'Deep Sleep' }],
          stack: ['glycine'],
          totalRecommendations: 1,
        },
      }),
    );
    const out = await getRecommendations(5, fetchImpl as unknown as typeof fetch);
    expect(out.recommendations[0]?.supplement.name).toBe('Magnesium');
    expect(out.meta.totalRecommendations).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/recommend?limit=5');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });
});
