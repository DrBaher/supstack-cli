import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { interactions } from './interactions';
import { research } from './research';

/**
 * THE GRADED ARM, THROUGH THE REAL HANDLERS.
 *
 * ⚠️ The API publishes `reviewState: 'authored'` on every graded interaction
 * row (since 2026-09-08: nothing in the corpus is signed, so nothing may say
 * `reviewed`). This package's zod unions accepted only `reviewed | ungraded`,
 * so `/safety` and `/interactions?medication=` responses carrying a graded row
 * threw a ZodError: `supstack research` and the MCP research tool failed on
 * every supplement with a graded interaction. The composition test beside
 * this one ran only the ungraded bee-pollen payload, so it stayed green.
 * Found by the 1 October 2026 audit.
 *
 * The payload is the generated fixture's `authored` block (ginkgo-biloba,
 * produced by the app's own `toPublicSafety`), not a hand-written one.
 */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../__fixtures__/ungraded-payloads.json'), 'utf8'),
) as {
  authored: {
    slug: string;
    drug: string;
    safetyResponse: { data: { safety: { drugInteractions: { severity: unknown; reviewState: string }[] } } };
    interactionsResponse: { data: { drugInteractions: { severity: unknown; reviewState: string }[] } };
  };
};
const authored = fixture.authored;

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

describe('an authored row on /safety through the research handler', () => {
  it('the fixture is still the authored shape this test is about', () => {
    const rows = authored.safetyResponse.data.safety.drugInteractions;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.reviewState === 'authored')).toBe(true);
    expect(rows.every((r) => typeof r.severity === 'string')).toBe(true);
  });

  it('parses, keeps the grade, and keeps the state', async () => {
    stubFetch((url) =>
      url.includes('/safety')
        ? authored.safetyResponse
        : { data: { slug: authored.slug, name: 'Ginkgo Biloba', evidence: { score: 6, level: 'moderate' } } },
    );
    const r = (await research.handler({ slug: authored.slug } as never)) as {
      safety?: { drugInteractions?: { severity: unknown; reviewState: string }[] };
    };
    const rows = r.safety?.drugInteractions ?? [];
    expect(rows.length).toBe(authored.safetyResponse.data.safety.drugInteractions.length);
    expect(rows.every((row) => row.reviewState === 'authored' && typeof row.severity === 'string')).toBe(
      true,
    );
    const text = strip(research.format.text(r as never));
    expect(text).toMatch(/severe/);
  });
});

describe('an authored row on /interactions?medication= through the interactions handler', () => {
  it('parses, and prints the grade', async () => {
    stubFetch(() => authored.interactionsResponse);
    const r = await interactions.handler({
      supplements: [authored.slug],
      medication: authored.drug,
    } as never);
    const out = r as {
      mode: string;
      results: { drugInteractions: { severity: unknown; reviewState: string }[] }[];
    };
    expect(out.mode).toBe('medication');
    expect(out.results[0]!.drugInteractions[0]!.reviewState).toBe('authored');
    expect(out.results[0]!.drugInteractions[0]!.severity).toBe('severe');
    const text = strip(interactions.format.text(r as never));
    expect(text).toMatch(/severe/);
    expect(text).not.toMatch(/not graded/);
  });
});
