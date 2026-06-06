import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStack } from '../storage';
import { rate } from './rate';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

const GRADE = {
  data: {
    letter: 'B',
    score: 81,
    verdict: 'Strong stack — well-matched with minor gaps.',
    goalsSource: 'provided',
    goals: [
      {
        id: 'deep-sleep',
        name: 'Improve deep sleep quality',
        coveredBy: 'magnesium',
        coverage: 77,
        label: 'strong',
      },
      { id: 'build-strength', name: 'Build strength & muscle', coveredBy: null, coverage: 0, label: 'none' },
    ],
    gaps: [{ id: 'build-strength', name: 'Build strength & muscle' }],
    stack: ['magnesium'],
    unknownSupplements: [],
    unknownGoals: [],
  },
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-rate-'));
  process.env.SUPSTACK_HOME = home;
  delete process.env.SUPSTACK_TOKEN;
});
afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('rate capability', () => {
  it('parses --goals as a comma string OR an array', () => {
    expect(rate.inputSchema.parse({ goals: 'deep-sleep, build-strength' }).goals).toEqual([
      'deep-sleep',
      'build-strength',
    ]);
    expect(rate.inputSchema.parse({ goals: ['deep-sleep'] }).goals).toEqual(['deep-sleep']);
    expect(rate.inputSchema.parse({}).supplements).toBeUndefined();
  });

  it('grades explicit supplements against provided goals', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(GRADE));
    vi.stubGlobal('fetch', fetchMock);

    const out = await rate.handler({ supplements: ['magnesium', 'l-theanine'], goals: ['deep-sleep'] });
    expect(out.letter).toBe('B');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/stack/grade');
    expect(decodeURIComponent(url)).toContain('supplements=magnesium,l-theanine');
    expect(decodeURIComponent(url)).toContain('goals=deep-sleep');
  });

  it('defaults to the local stack when no supplements are passed', async () => {
    setStack(['magnesium']);
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(GRADE));
    vi.stubGlobal('fetch', fetchMock);

    await rate.handler({ goals: ['deep-sleep'] });
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain('supplements=magnesium');
  });

  it('omits goals from the request when none are resolved (server infers)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(GRADE));
    vi.stubGlobal('fetch', fetchMock);

    await rate.handler({ supplements: ['magnesium'] });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('goals=');
  });

  it('throws a helpful error when the stack is empty', async () => {
    await expect(rate.handler({})).rejects.toThrow(/empty/i);
  });

  it('renders a grade with per-goal coverage and gaps', () => {
    const text = rate.format.text(GRADE.data as never);
    expect(text).toContain('Stack grade:');
    expect(text).toContain('B');
    expect(text).toContain('81/100');
    expect(text).toContain('Improve deep sleep quality');
    expect(text).toContain('Gaps:');
    expect(text).toContain('Build strength & muscle');
  });
});
