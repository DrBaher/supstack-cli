import { afterEach, describe, expect, it, vi } from 'vitest';

import { studies } from './studies';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

const clean = {
  title: 'Magnesium and sleep quality',
  journal: 'Sleep',
  year: 2024,
  study_type: 'rct',
  supplement_names: ['Magnesium'],
  doi: '10.1/clean',
  retracted: false,
  retractionNotice: null,
};

const retracted = {
  title: 'Effects of aged garlic extract on blood pressure',
  journal: 'Prostaglandins Other Lipid Mediat',
  year: 2024,
  study_type: 'meta-analysis',
  supplement_names: ['Aged Garlic Extract'],
  doi: '10.1016/j.prostaglandins.2024.106914',
  retracted: true,
  retractionNotice: 'Retracted — Unreliable Results and/or Conclusions · 2025-01-10',
};

const concern = {
  ...clean,
  title: 'Vitamin E and mortality',
  retracted: false,
  retractionNotice: 'Expression of concern — Concerns/Issues about Data',
};

describe('studies capability — retraction marker', () => {
  it('keeps the API flags through the zod schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonRes({ data: [retracted, clean], meta: { total: 2 } })),
    );
    const { studies: rows } = await studies.handler({ query: 'garlic', sort: 'newest', limit: 10 } as never);
    expect(rows[0]!).toMatchObject({ retracted: true, retractionNotice: retracted.retractionNotice });
    expect(rows[1]!).toMatchObject({ retracted: false });
  });

  it('text output prints a visible RETRACTED marker and the notice, never a bare title', () => {
    const text = studies.format.text({ studies: [retracted, clean], total: 2 });
    const lines = text.split('\n');
    const titleLine = lines.find((l) => l.includes(retracted.title))!;
    expect(titleLine).toContain('RETRACTED');
    expect(text).toContain(retracted.retractionNotice);
    // The clean row is unmarked.
    const cleanLine = lines.find((l) => l.includes(clean.title))!;
    expect(cleanLine).not.toContain('RETRACTED');
  });

  it('an expression of concern is marked as such, not as retracted', () => {
    const text = studies.format.text({ studies: [concern], total: 1 });
    expect(text).toContain('EXPRESSION OF CONCERN');
    expect(text).not.toContain('RETRACTED');
  });

  it('json output (the MCP path) passes the flags through untouched', () => {
    const out = studies.format.json({ studies: [retracted], total: 1 }) as { studies: (typeof retracted)[] };
    expect(out.studies[0]!.retracted).toBe(true);
    expect(out.studies[0]!.retractionNotice).toBe(retracted.retractionNotice);
  });

  it('an older API without the fields still parses (flags optional)', async () => {
    const { retracted: _r, retractionNotice: _n, ...legacy } = clean;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ data: [legacy] })));
    const { studies: rows } = await studies.handler({ sort: 'newest', limit: 10 } as never);
    expect(rows[0]!.retracted).toBeUndefined();
    expect(studies.format.text({ studies: rows })).not.toContain('RETRACTED');
  });
});
