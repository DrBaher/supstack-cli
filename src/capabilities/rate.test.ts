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
    ratingLabel: 'Strong',
    summary: 'Your stack scores 81 out of 100 (grade B) — a strong match for your goals.',
    verdict: 'Strong stack — well-matched with minor gaps.',
    goalsSource: 'provided',
    goals: [
      {
        id: 'deep-sleep',
        name: 'Perceived sleep quality',
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

  it('renders a self-explanatory grade with coverage, gaps, and the goal source', () => {
    const text = rate.format.text(GRADE.data as never);
    expect(text).toContain('Stack grade:');
    expect(text).toContain('81/100');
    // The headline explains what the letter/score mean — not a bare "B".
    expect(text).toContain('strong match for your goals');
    expect(text).toContain('Perceived sleep quality');
    expect(text).toContain('Gaps:');
    // Provided goals are stated plainly.
    expect(text).toContain('Graded against the goals you gave');
  });

  it('flags inferred goals and tells the user they can specify their own', () => {
    const inferred = {
      ...GRADE.data,
      goalsSource: 'inferred',
      ratingLabel: 'Weak',
      letter: 'D',
      score: 41,
    };
    const text = rate.format.text(inferred as never);
    expect(text).toMatch(/inferred from your stack/i);
    expect(text).toContain('--goals');
    expect(text).toContain('weak match');
  });
});

/**
 * The grade is goal COVERAGE only, so adding a supplement can only raise it —
 * even one that conflicts with something already in the stack. The API grew an
 * `interactions[]` field so a caller could not relay a reassuring grade for a
 * stack it had itself flagged; the CLI's Zod schema did not, so the field was
 * silently stripped and `iron` + `zinc` (major) printed as a clean grade.
 */
describe('rate capability — flagged interactions', () => {
  const WITH_INTERACTIONS = {
    ...GRADE.data,
    interactions: [
      {
        supplements: ['iron', 'zinc'] as [string, string],
        severity: 'major',
        type: 'conflict',
        effect: 'Competes for the same absorption transporters',
        recommendation: 'Separate doses by at least 2 hours',
      },
    ],
  };

  it('prints them, names the pair, and says the score does not include them', () => {
    const text = rate.format.text(WITH_INTERACTIONS as never);
    expect(text).toContain('iron + zinc');
    expect(text).toMatch(/flagged interaction/i);
    expect(text).toMatch(/not reflected in the score/i);
  });

  it('says nothing when there are none', () => {
    const text = rate.format.text({ ...GRADE.data, interactions: [] } as never);
    expect(text).not.toMatch(/flagged interaction/i);
  });

  it('does not throw when the field is absent (older API, hand-built payloads)', () => {
    expect(() => rate.format.text(GRADE.data as never)).not.toThrow();
  });

  it('parses the field off the wire rather than stripping it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ data: WITH_INTERACTIONS }));
    vi.stubGlobal('fetch', fetchMock);
    const result = (await rate.handler({ supplements: ['iron', 'zinc'] })) as {
      interactions: { supplements: [string, string] }[];
    };
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0]?.supplements).toEqual(['iron', 'zinc']);
  });
});
