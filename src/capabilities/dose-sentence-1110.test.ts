import { afterEach, describe, expect, it, vi } from 'vitest';

import { research } from './research';

/**
 * Item 1110 (pharmacist, proposed 10 November 2026, confirmed by the owner as her ruling). The API publishes `dosage.recommended`
 * as null where the legacy sentence is hidden, with her caveat (`caveat`) and her Q2 sentence (`assessmentStatement`) beside it.
 * The zod parse STRIPS undeclared keys and rejects a null in a string field, so both must be declared and printed.
 */
const CAVEAT =
  'If this treatment was prescribed for you, follow your prescriber’s directions. Do not change prescribed treatment because this page has no matched dose range.';
const Q2 =
  'SupStack cannot assess this dose because a matching reference range is not available. This does not mean the dose is safe. Follow any separate safety advice shown.';
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s: string) => s.replace(ANSI, '');

afterEach(() => vi.unstubAllGlobals());

describe('item 1110 reaches the CLI and MCP output', () => {
  it('parses a null recommended, keeps her caveat and her Q2 sentence, and prints no dose line', async () => {
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
                name: 'Acarbose',
                slug: 'acarbose',
                dosage: {
                  recommended: null,
                  minimum: null,
                  maximum: null,
                  limitState: 'studied-only',
                  rangeStatement: 'W',
                  caveat: CAVEAT,
                  assessmentStatement: Q2,
                },
              },
            }),
          }) as unknown as Response,
      ),
    );
    const r = (await research.handler({ slug: 'acarbose' } as never)) as {
      detail: {
        dosage?: { recommended?: string | null; caveat?: string | null; assessmentStatement?: string | null };
      };
    };
    expect(r.detail.dosage?.recommended).toBeNull();
    expect(r.detail.dosage?.caveat).toBe(CAVEAT);
    expect(r.detail.dosage?.assessmentStatement).toBe(Q2);
    const text = strip(research.format.text(r as never));
    expect(text).toContain(CAVEAT);
    expect(text).toContain(Q2);
    expect(text).not.toMatch(/Dose {2}/);
  });
});
