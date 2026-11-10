import { afterEach, describe, expect, it, vi } from 'vitest';

import { interactions } from './interactions';
import { research } from './research';

/**
 * Pharmacist ruling 152 (4 October 2026): an entry interaction grade resting on
 * an unresolved entry-vs-table disagreement is PROVISIONAL, and the API marks it
 * `gradeConfidence: 'provisional'` with a `provisionalNote`, beside an
 * unchanged `severity`. Zod strips unknown keys, so a schema that did not carry
 * the marker would print the grade as settled in text, JSON and MCP output
 * alike. The row shape is `toPublicInteraction`'s graded arm.
 */
const NOTE = 'This interaction grade is provisional.';
const row = {
  medication: 'Digoxin',
  description: 'May increase digoxin toxicity.',
  reviewState: 'authored',
  severity: 'severe',
  gradeConfidence: 'provisional',
  provisionalNote: NOTE,
};

afterEach(() => vi.unstubAllGlobals());

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s: string) => s.replace(ANSI, '');

function stubFetch(body: (url: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => body(String(url)),
        }) as unknown as Response,
    ),
  );
}

describe('a provisional grade through the CLI', () => {
  it('interactions --medication keeps the marker and withholds the grade (ruling 262)', async () => {
    stubFetch(() => ({
      data: { supplement: { id: '1', name: 'Aloe Vera', slug: 'aloe-vera' }, drugInteractions: [row] },
      meta: { assessmentState: 'graded' },
    }));
    const r = (await interactions.handler({
      supplements: ['aloe-vera'],
      medication: 'digoxin',
    } as never)) as {
      results: { drugInteractions: { gradeConfidence?: string; severity: unknown }[] }[];
    };
    expect(r.results[0]!.drugInteractions[0]!.gradeConfidence).toBe('provisional');
    expect(r.results[0]!.drugInteractions[0]!.severity).toBe('severe');
    const text = strip(interactions.format.text(r as never));
    // Ruling 262 (7 October 2026): even an older payload's provisional grade is
    // withheld: "grade not validated", never the severity word.
    expect(text).toMatch(/Aloe Vera {2}grade not validated/);
    expect(text).not.toMatch(/severe/);
    expect(text).toContain(NOTE);
  });

  it('research keeps the marker on /safety rows and prints it', async () => {
    stubFetch((url) =>
      url.includes('/safety')
        ? { data: { safety: { drugInteractions: [row] } } }
        : { data: { slug: 'aloe-vera', name: 'Aloe Vera', evidence: { score: 5, level: 'moderate' } } },
    );
    const r = (await research.handler({ slug: 'aloe-vera' } as never)) as {
      safety?: { drugInteractions?: { gradeConfidence?: string }[] };
    };
    expect(r.safety?.drugInteractions?.[0]?.gradeConfidence).toBe('provisional');
    const text = strip(research.format.text(r as never));
    expect(text).toMatch(/Digoxin — grade not validated/);
    expect(text).not.toMatch(/severe/);
  });

  it('an ordinary graded row prints no provisional state', async () => {
    const plain = { ...row, gradeConfidence: undefined, provisionalNote: undefined };
    stubFetch(() => ({
      data: { supplement: { id: '1', name: 'Aloe Vera', slug: 'aloe-vera' }, drugInteractions: [plain] },
      meta: { assessmentState: 'graded' },
    }));
    const r = await interactions.handler({ supplements: ['aloe-vera'], medication: 'digoxin' } as never);
    expect(strip(interactions.format.text(r as never))).not.toMatch(/provisional/);
  });
});

/**
 * Pharmacist ruling 254 (6 October 2026): the API now holds a provisional or
 * class-term grade instead of publishing it ("Do not expose held/unvalidated
 * grades as clinical severity even with provisional wording"). The row comes
 * on the ungraded arm with `reviewStatus`, and the CLI says the grade is not
 * validated, in text and in what it passes on to an MCP client.
 */
describe('ruling 254: a held grade through the CLI', () => {
  const held = {
    medication: 'Digoxin',
    description: 'May increase digoxin toxicity.',
    reviewState: 'ungraded',
    severity: null,
    reviewStatus: 'provisional',
    ungradedNote:
      'A grade for this interaction is held for clinical review and has not been validated, so no severity is given.',
  };

  it('interactions --medication prints "grade not validated" and no severity word', async () => {
    stubFetch(() => ({
      data: { supplement: { id: '1', name: 'Aloe Vera', slug: 'aloe-vera' }, drugInteractions: [held] },
      meta: { assessmentState: 'ungraded-only' },
    }));
    const r = (await interactions.handler({
      supplements: ['aloe-vera'],
      medication: 'digoxin',
    } as never)) as {
      results: { drugInteractions: { reviewStatus?: string; severity: unknown }[] }[];
    };
    expect(r.results[0]!.drugInteractions[0]!.reviewStatus).toBe('provisional');
    expect(r.results[0]!.drugInteractions[0]!.severity).toBeNull();
    const text = strip(interactions.format.text(r as never));
    expect(text).toMatch(/grade not validated/);
    expect(text).not.toMatch(/\bsevere\b|\bmajor\b/);
  });

  it('research prints it the same way', async () => {
    stubFetch((url) =>
      url.includes('/safety')
        ? { data: { safety: { drugInteractions: [held] } } }
        : { data: { slug: 'aloe-vera', name: 'Aloe Vera', evidence: { score: 5, level: 'moderate' } } },
    );
    const r = await research.handler({ slug: 'aloe-vera' } as never);
    expect(strip(research.format.text(r as never))).toMatch(/Digoxin — grade not validated/);
  });

  it('an empty pair list is not "none": it says not assessed and not an all-clear', async () => {
    stubFetch(() => ({
      data: {
        supplements: [
          { id: '1', name: 'A' },
          { id: '2', name: 'B' },
        ],
        supplementInteractions: [],
        sharedDrugConcerns: [],
      },
    }));
    const r = await interactions.handler({ supplements: ['a', 'b'] } as never);
    const text = strip(interactions.format.text(r as never));
    expect(text).toMatch(/Not assessed, and not an all-clear/);
    expect(text).not.toMatch(/No notable pairwise interactions found/);
  });
});
