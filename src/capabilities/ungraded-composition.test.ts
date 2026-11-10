import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { interactions } from './interactions';
import { research } from './research';

/**
 * THE REAL PUBLIC PAYLOAD, THROUGH THE REAL HANDLERS.
 *
 * Owner ruling R-005-06, paths 2 and 3: source JSON → `/api/v1/safety` → the
 * real CLI/MCP `research` handler → text AND machine output, and the same for
 * `/interactions`.
 *
 * ⚠️ THE FIXTURE IS GENERATED FROM THE CORPUS, not written by hand. The recheck
 * was explicit that "mocked already-correct payloads remain useful unit tests,
 * but they do not satisfy this composition gate" — and it was right about this
 * exact file: the previous CLI interaction test mocked a corrected response, so
 * it stayed green while `research.ts` crashed on the real one.
 *
 * `scripts/generate-ungraded-fixture.ts` produces it from `bee-pollen`'s real
 * ungraded row via the app's own `toPublicSafety`, and the app-side matrix test
 * fails if this file drifts from what the app would produce today. So the CLI
 * package gets a real payload without importing the app.
 */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../__fixtures__/ungraded-payloads.json'), 'utf8'),
) as {
  slug: string;
  drug: string;
  safetyResponse: { data: { safety: { drugInteractions: { severity: unknown; reviewState: string }[] } } };
  interactionsResponse: { data: { drugInteractions: { severity: unknown; matchedVia?: string }[] } };
};

afterEach(() => vi.unstubAllGlobals());

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s: string) => s.replace(ANSI, '');

describe('the real /safety payload through the real research handler', () => {
  it('the fixture is still the ungraded shape this test is about', () => {
    const row = fixture.safetyResponse.data.safety.drugInteractions[0];
    expect(row, 'the fixture lost its interaction row').toBeDefined();
    expect(row!.reviewState).toBe('ungraded');
    expect(row!.severity).toBeNull();
  });

  it('parses instead of throwing — the regression that shipped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = String(url).includes('/safety')
          ? fixture.safetyResponse
          : {
              data: {
                slug: fixture.slug,
                name: 'Bee Pollen',
                evidence: { score: 5, level: 'moderate', totalStudies: 1 },
              },
            };
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => body,
        } as unknown as Response;
      }),
    );
    // Before the fix this threw `ZodError: expected string, received null`.
    const r = await research.handler({ slug: fixture.slug } as never);
    expect(r).toBeTruthy();
  });

  it('and the machine output carries no grade for it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = String(url).includes('/safety')
          ? fixture.safetyResponse
          : {
              data: {
                slug: fixture.slug,
                name: 'Bee Pollen',
                evidence: { score: 5, level: 'moderate', totalStudies: 1 },
              },
            };
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => body,
        } as unknown as Response;
      }),
    );
    const r = (await research.handler({ slug: fixture.slug } as never)) as {
      safety?: { drugInteractions?: { severity: unknown; medication: string }[] };
    };
    const rows = r.safety?.drugInteractions ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // MCP serialises this value directly, so this IS the agent-facing output.
    for (const row of rows) expect(row.severity).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/"severity":\s*"mild"/);
  });
});

describe('the real /interactions payload through the real interactions handler', () => {
  const stub = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => fixture.interactionsResponse,
          }) as unknown as Response,
      ),
    );

  it('parses, and keeps severity null', async () => {
    stub();
    const r = (await interactions.handler({
      supplements: [fixture.slug],
      medication: fixture.drug,
    } as never)) as { mode: string; results: { drugInteractions: { severity: unknown }[] }[] };
    expect(r.mode).toBe('medication');
    expect(r.results[0]?.drugInteractions[0]).toBeDefined();
    expect(r.results[0]!.drugInteractions[0]!.severity).toBeNull();
  });

  it('renders "not graded" and never a severity word', async () => {
    stub();
    const r = await interactions.handler({
      supplements: [fixture.slug],
      medication: fixture.drug,
    } as never);
    const text = strip(interactions.format.text(r as never));
    /**
     * ⚠️ Asserted on the GRADE LINE, not the whole output. The row's own
     * description (ruling 177, 5 Oct 2026) names the anticoagulant medicines, so a blanket
     * `not.toMatch(/mild/)` fails on prose and proves nothing about the grade —
     * the same blunt-assertion mistake made twice already in this thread.
     */
    const gradeLine = text.split('\n').find((l) => l.includes('Bee Pollen'))!;
    expect(gradeLine).toContain('not graded');
    expect(gradeLine).not.toMatch(/\b(mild|minor|moderate|major|severe|critical)\b/i);
    // It reached the reader through the drug's CLASS, and says so.
    expect(gradeLine).toMatch(/class match/);
    // The description still reaches them — the warning is kept, only the grade is not.
    expect(text).toMatch(/anticoagulant or antiplatelet medicine/);
  });

  it('and never renders a green all-clear for it', async () => {
    stub();
    const r = await interactions.handler({
      supplements: [fixture.slug],
      medication: fixture.drug,
    } as never);
    // The failure the whole CLIN-005 thread started from.
    expect(strip(interactions.format.text(r as never))).not.toMatch(
      /no known interaction|No documented interaction was found/i,
    );
  });
});

/**
 * Residuals D and C from the 2026-09-04b recheck, on the real payloads.
 */
describe('the research TEXT formatter, not just its parser', () => {
  const stub = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = String(url).includes('/safety')
          ? fixture.safetyResponse
          : {
              data: {
                slug: fixture.slug,
                name: 'Bee Pollen',
                evidence: { score: 5, level: 'moderate', totalStudies: 1 },
              },
            };
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => body,
        } as unknown as Response;
      }),
    );

  it('never prints the literal "null" as a severity', async () => {
    stub();
    const r = await research.handler({ slug: fixture.slug } as never);
    const text = strip(research.format.text(r as never));
    // The recheck reproduced `Warfarin — null` here. The composition tests
    // added before it asserted parsing and machine output only, and never
    // called this formatter.
    expect(text).not.toMatch(/—\s*null\b/);
    expect(text).toMatch(/not graded/);
  });

  it('and shows the disclosure it used to omit', async () => {
    stub();
    const r = await research.handler({ slug: fixture.slug } as never);
    expect(strip(research.format.text(r as never))).toMatch(/not been individually evaluated/);
  });
});

describe('an unrecognised medication is never green', () => {
  it('renders "not assessed", not "no known interaction"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            // Exactly what the route returns for an unknown drug: an empty list,
            // plus the state that says WHY it is empty.
            json: async () => ({
              data: {
                supplement: { id: 'bee-pollen', name: 'Bee Pollen', slug: 'bee-pollen' },
                drugInteractions: [],
              },
              meta: { assessmentState: 'ungraded-only' },
            }),
          }) as unknown as Response,
      ),
    );
    const r = await interactions.handler({
      supplements: ['bee-pollen'],
      medication: 'zzz-not-a-drug',
    } as never);
    const text = strip(interactions.format.text(r as never));
    // The recheck reproduced the green branch on this exact shape.
    expect(text).not.toMatch(/no known interaction|No documented interaction was found/i);
    expect(text).toMatch(/not assessed/i);
  });

  it('but a genuinely clear result still says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              data: {
                supplement: { id: 'creatine', name: 'Creatine', slug: 'creatine' },
                drugInteractions: [],
              },
              meta: { assessmentState: 'clear' },
            }),
          }) as unknown as Response,
      ),
    );
    const r = await interactions.handler({ supplements: ['creatine'], medication: 'warfarin' } as never);
    // Pharmacist ruling 263 (7 October 2026): a library "clear" prints her
    // coverage sentence, never "no known interaction".
    expect(strip(interactions.format.text(r as never))).toContain(
      'No documented interaction was found in the data searched. This does not establish that this exact combination is safe.',
    );
  });
});

/**
 * ⚠️ THE TWO RESIDUALS THE 2026-09-06 RECHECK LEFT OPEN, both closed by crossing
 * the real route into the real consumer rather than by unit-testing a helper.
 * The recheck's own words on the second one: "no real ungraded recommendation
 * test crosses the route into this consumer."
 */
describe('a missing assessment state fails closed', () => {
  it('a response with NO meta at all is not green', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            // No `meta` key whatsoever — the shape the recheck probed with.
            json: async () => ({
              data: {
                supplement: { id: 'bee-pollen', name: 'Bee Pollen', slug: 'bee-pollen' },
                drugInteractions: [],
              },
            }),
          }) as unknown as Response,
      ),
    );
    const r = await interactions.handler({
      supplements: ['bee-pollen'],
      medication: 'warfarin',
    } as never);
    const text = strip(interactions.format.text(r as never));
    expect(text, 'absence of a state must not satisfy the green branch').not.toMatch(
      /no known interaction|No documented interaction was found/i,
    );
    expect(text).toMatch(/not assessed/i);
  });

  it('and meta present but empty is likewise not green', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              data: {
                supplement: { id: 'bee-pollen', name: 'Bee Pollen', slug: 'bee-pollen' },
                drugInteractions: [],
              },
              meta: {},
            }),
          }) as unknown as Response,
      ),
    );
    const r = await interactions.handler({
      supplements: ['bee-pollen'],
      medication: 'warfarin',
    } as never);
    expect(strip(interactions.format.text(r as never))).toMatch(/not assessed/i);
  });
});
