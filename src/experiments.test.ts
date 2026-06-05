import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotLoggedInError } from './cloud-stack';
import { getExperiment, getExperiments, resolveExperimentId } from './experiments';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-exp-'));
  process.env.SUPSTACK_HOME = home;
  delete process.env.SUPSTACK_TOKEN;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('experiments', () => {
  it('requires a token', async () => {
    await expect(getExperiments()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(getExperiment('abc')).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('getExperiments GETs /me/experiments with the status filter + Bearer', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: [
          {
            id: 'exp-1',
            supplement: { slug: 'magnesium', name: 'Magnesium' },
            goal: { id: 'deep-sleep', name: 'Deep Sleep' },
            status: 'active',
            verdict: null,
            verdictSummary: null,
            progress: { completed: 2, expected: 4 },
            startedAt: '2026-05-01',
            completedAt: null,
            nextCheckInDate: '2026-06-10',
          },
        ],
      }),
    );
    const out = await getExperiments('active', fetchImpl as unknown as typeof fetch);
    expect(out[0]?.supplement.name).toBe('Magnesium');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/experiments?status=active');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('getExperiment GETs /me/experiments/:id', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          id: 'exp-1',
          supplement: { slug: 'magnesium', name: 'Magnesium' },
          goal: { id: 'deep-sleep', name: 'Deep Sleep' },
          status: 'completed',
          verdict: 'clear-win',
          verdictSummary: 'Slept better.',
          verdictDetails: null,
          protocol: null,
          progress: { completed: 4, expected: 4 },
          startedAt: '2026-05-01',
          baselineCompletedAt: '2026-05-02',
          completedAt: '2026-05-30',
          nextCheckInDate: null,
          responses: [],
        },
      }),
    );
    const out = await getExperiment('exp-1', fetchImpl as unknown as typeof fetch);
    expect(out.verdict).toBe('clear-win');
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url)).toContain('/me/experiments/exp-1');
  });

  it('resolveExperimentId passes a full uuid through without a network call', async () => {
    const uuid = '8b03297e-0000-4000-8000-000000000000';
    await expect(resolveExperimentId(uuid)).resolves.toBe(uuid);
  });

  it('resolveExperimentId resolves a short prefix via the list', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const full = '8b03297e-1111-4111-8111-111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: [
            {
              id: full,
              supplement: { slug: 'magnesium', name: 'Magnesium' },
              goal: { id: 'g', name: 'G' },
              status: 'completed',
              verdict: null,
              verdictSummary: null,
              progress: { completed: 4, expected: 4 },
              startedAt: null,
              completedAt: null,
              nextCheckInDate: null,
            },
            {
              id: 'd3d0de39-2222-4222-8222-222222222222',
              supplement: { slug: 'l-theanine', name: 'L-Theanine' },
              goal: { id: 'g', name: 'G' },
              status: 'completed',
              verdict: null,
              verdictSummary: null,
              progress: { completed: 4, expected: 4 },
              startedAt: null,
              completedAt: null,
              nextCheckInDate: null,
            },
          ],
        }),
      ),
    );
    await expect(resolveExperimentId('8b03297e')).resolves.toBe(full);
    await expect(resolveExperimentId('zzzz')).rejects.toThrow(/No experiment matching/);
    vi.unstubAllGlobals();
  });
});
