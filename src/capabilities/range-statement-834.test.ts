import { afterEach, describe, expect, it, vi } from 'vitest';

import { research } from './research';

/**
 * Item 834 (pharmacist follow-up, 10 November 2026, sheet 2): "Use W721 where a dose explanation is expected."
 * For a studied-only entry the API publishes minimum/maximum null and `dosage.rangeStatement` = W721. The CLI and the MCP
 * server parse the response through zod, which STRIPS undeclared keys, so before this the sentence never reached them and a
 * dose with no range read like a broken panel.
 */
const W721 = 'A source-matched dose range is not available for this product and use.';
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s: string) => s.replace(ANSI, '');

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
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
              name: 'Ashwagandha',
              slug: 'ashwagandha',
              dosage: {
                recommended: null, // item 1110: the legacy sentence is hidden, the API publishes null
                minimum: null,
                maximum: null,
                limitState: 'studied-only',
                doseStatement: null,
                rangeStatement: W721,
              },
            },
          }),
        }) as unknown as Response,
    ),
  );
}

describe('W721 reaches the CLI and MCP output', () => {
  it('research keeps rangeStatement in its result and prints it, and never a numeric range', async () => {
    stubFetch();
    const r = (await research.handler({ slug: 'ashwagandha' } as never)) as {
      detail: { dosage?: { rangeStatement?: string | null } };
    };
    expect(r.detail.dosage?.rangeStatement).toBe(W721);
    expect(strip(research.format.text(r as never))).toContain(W721);
  });

  it('export carries it per item, in JSON and in the Markdown', async () => {
    stubFetch();
    vi.resetModules();
    vi.doMock('../storage', async (orig) => ({
      ...(await orig<typeof import('../storage')>()),
      readStack: () => ['ashwagandha'],
    }));
    const { exportStack: ex } = await import('./export');
    const r = await ex.handler({ format: 'md' } as never);
    expect(r.items[0]?.doseRangeStatement).toBe(W721);
    expect(strip(ex.format.text(r as never))).toContain(`**Dose range:** ${W721}`);
  });
});
