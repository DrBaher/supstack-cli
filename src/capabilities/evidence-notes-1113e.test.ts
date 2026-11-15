import { afterEach, describe, expect, it, vi } from 'vitest';

import { research } from './research';

/**
 * Item 1113 part e (pharmacist, 13 November 2026 evening, confirmed by the owner as her ruling). `/safety` returns `evidenceNotes`: her
 * scoped uncertainty notes, which are not adverse events and carry no grade. The zod parse STRIPS undeclared keys, so the field must be
 * declared, and the text output prints it apart from the side-effect list.
 */
const NOTE =
  'Short-term trial summaries do not establish the long-term safety of 7-keto-DHEA. The frequency and severity of adverse effects are not established by the information provided here.';
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s: string) => s.replace(ANSI, '');

afterEach(() => vi.unstubAllGlobals());

const reply = (data: unknown) =>
  ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data }) }) as unknown as Response;

describe('item 1113 part e reaches the CLI and MCP output', () => {
  it('keeps her notes through the parse and prints them under their own heading, never as a side effect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/safety')
          ? reply({ safety: { overallRating: 'caution', sideEffects: [], evidenceNotes: [NOTE] } })
          : reply({ name: '7-Keto-DHEA', slug: '7-keto-dhea' }),
      ),
    );
    const r = (await research.handler({ slug: '7-keto-dhea' } as never)) as {
      safety?: { evidenceNotes?: string[] };
    };
    expect(r.safety?.evidenceNotes).toEqual([NOTE]);
    const text = strip(research.format.text(r as never));
    expect(text).toContain('Evidence and uncertainty:');
    expect(text).toContain(NOTE);
    expect(text).not.toContain('Side effects (');
  });

  it('an older server that sends no evidenceNotes still parses and prints no heading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/safety')
          ? reply({ safety: { overallRating: 'high', sideEffects: [] } })
          : reply({ name: 'X', slug: 'x' }),
      ),
    );
    const r = (await research.handler({ slug: 'x' } as never)) as never;
    expect(strip(research.format.text(r))).not.toContain('Evidence and uncertainty');
  });
});
