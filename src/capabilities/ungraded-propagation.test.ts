import { afterEach, describe, expect, it, vi } from 'vitest';

import { interactions } from './interactions';

/**
 * The API marks an interaction row `ungraded` when its severity is a wholesale
 * default rather than a clinical grading. The CLI must not print such a row as
 * a graded verdict.
 *
 * ⚠️ WHY THIS FILE EXISTS. The flag was added to the API and to the web
 * surfaces, and `cli/src` had zero references to it — so `supstack interactions
 * bee-pollen --medication warfarin` printed a confident `mild` to exactly the
 * reader the disclosure was written for. Two independent things were wrong:
 * the renderer had no branch, AND the zod schema omitted the key, which means
 * zod STRIPPED it before the renderer could ever have seen it. A renderer fix
 * alone would have looked correct and changed nothing.
 */
afterEach(() => vi.unstubAllGlobals());

describe('ungraded interaction rows survive the CLI boundary', () => {
  /**
   * ⚠️ 2026-09-03: the shape CHANGED, and that is the fix.
   *
   * This row used to be `{ severity: 'mild', ungraded: true }` — the grade was
   * published and merely labelled. Text mode honoured the label; JSON and MCP
   * did not, so the same row told a person "not graded" and an agent "mild".
   * The 2026-09-01 clinical review required the grade to be ABSENT
   * (CLIN-005 containment audit, finding 3), so an ungraded row now carries
   * `severity: null` and there is no field anywhere holding the raw value.
   */
  const row = {
    medication: 'Blood thinners',
    severity: null,
    reviewState: 'ungraded' as const,
    description: 'May affect platelet aggregation or vitamin K-dependent clotting factors.',
    ungradedNote: 'This possible interaction has not been individually evaluated.',
  };
  const result = {
    mode: 'medication' as const,
    medication: 'warfarin',
    results: [
      {
        supplement: { id: '1', name: 'Bee Pollen', slug: 'bee-pollen' },
        drugInteractions: [row],
      },
    ],
  };

  /** Strip ANSI colour so assertions read the words, not the escapes. */
  // Built via constructor: a literal ESC in a regex trips `no-control-regex`.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const strip = (s: string): string => s.replace(ANSI, '');

  it('does not print the ungraded row as a severity word', () => {
    const out = strip(interactions.format.text(result as never));
    expect(out).not.toMatch(/\bmild\b/i);
    expect(out).toContain('not graded');
  });

  it('shows the reader the note explaining why', () => {
    const out = strip(interactions.format.text(result as never));
    expect(out).toContain('has not been individually evaluated');
  });

  it('a genuinely graded row still prints its severity', () => {
    const graded = {
      ...result,
      results: [
        {
          supplement: { id: '1', name: 'Ginkgo', slug: 'ginkgo' },
          drugInteractions: [
            {
              medication: 'warfarin',
              severity: 'moderate',
              reviewState: 'reviewed' as const,
              description: 'Increases bleeding risk.',
            },
          ],
        },
      ],
    };
    const out = strip(interactions.format.text(graded as never));
    expect(out).toMatch(/moderate/i);
    expect(out).not.toContain('not graded');
  });

  /**
   * ⚠️ THE VERSION OF THIS TEST THAT SHIPPED FIRST WAS VACUOUS.
   *
   * It called `format.json` on a raw literal and asserted the flag was still
   * there — but `format.json` is the identity function, and the zod schema only
   * runs inside `handler`. Deleting `ungraded` from the schema left that test
   * green, which is precisely the mutation it existed to catch.
   *
   * So this drives the REAL boundary: a mocked API response carrying the flag,
   * through `handler`, through zod's strip. The MCP server serialises exactly
   * this value, so this is also what makes the MCP surface correct without a
   * second code path.
   */
  it('the schema preserves the flag through a real handler parse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            data: {
              supplement: { id: 'bee-pollen', name: 'Bee Pollen', slug: 'bee-pollen' },
              drugInteractions: [row],
            },
          }),
        } as unknown as Response),
      ),
    );

    const r = await interactions.handler({ supplements: ['bee-pollen'], medication: 'warfarin' });
    expect(r.mode).toBe('medication');
    if (r.mode !== 'medication') return;

    // The grade must be ABSENT, not merely flagged: assert both the
    // discriminator AND that no field carries the raw value through.
    expect(r.results[0]?.drugInteractions[0]).toMatchObject({
      reviewState: 'ungraded',
      severity: null,
      ungradedNote: expect.stringContaining('not been individually evaluated'),
    });
    expect(JSON.stringify(r.results[0]?.drugInteractions[0])).not.toMatch(/mild/i);

    // And the rendered output of that parsed value never says "mild".
    expect(strip(interactions.format.text(r))).not.toMatch(/\bmild\b/i);
  });
});
