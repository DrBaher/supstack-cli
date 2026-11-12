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

/**
 * Item 1110 Q3 and Q4 (837, 10 November 2026): `safety.doseLimit` carries `category`, `referenceSource` and `personalComparison`.
 * The parse strips undeclared keys, so they must be declared, and the text output prints her "not assessed" sentence under the
 * labelled reference number.
 */
const THIRD_FORM =
  'An upper intake limit is listed, but we cannot apply it to this product or person because its scope or the intake information is incomplete. This is not a finding that the dose is safe.';

describe('item 1110 Q3 and Q4 (837) reaches the CLI and MCP output', () => {
  it('keeps and prints the personal comparison statement and the reference source', async () => {
    const reply = (data: unknown) =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data }),
      }) as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/safety')
          ? reply({
              safety: {
                overallRating: 'moderate',
                doseLimit: {
                  doseLimitText: 'EFSA reference text',
                  label: 'Established upper intake limit',
                  labelKind: 'established-upper-limit',
                  limitState: 'regulatory-limit',
                  source: 'authority-upper-intake-limit',
                  value: 2500,
                  unit: 'mg',
                  population: 'adults',
                  form: null,
                  isModelEstimate: false,
                  category: 'upper-intake-limit',
                  referenceSource: { label: 'EFSA UL overview', url: 'https://example.org/efsa' },
                  personalComparison: { status: 'not-assessed', statement: THIRD_FORM },
                },
              },
            })
          : reply({
              name: 'Calcium',
              slug: 'calcium',
              dosage: { recommended: '1000 mg', assessmentStatement: THIRD_FORM },
            }),
      ),
    );
    const r = (await research.handler({ slug: 'calcium' } as never)) as {
      safety?: {
        doseLimit?: { personalComparison?: { statement: string } | null; category?: string | null };
      };
    };
    expect(r.safety?.doseLimit?.category).toBe('upper-intake-limit');
    expect(r.safety?.doseLimit?.personalComparison?.statement).toBe(THIRD_FORM);
    const text = strip(research.format.text(r as never));
    expect(text).toContain('Established upper intake limit:');
    expect(text).toContain('https://example.org/efsa');
    expect(text).toContain(THIRD_FORM);
  });
});
