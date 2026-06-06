import { afterEach, describe, expect, it, vi } from 'vitest';

import { interactions } from './interactions';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('interactions --medication', () => {
  it('checks each supplement against the medication (one drug call per supplement)', async () => {
    const fetchMock = vi.fn((url: string) => {
      const u = new URL(String(url));
      const slug = u.searchParams.get('supplement');
      const body =
        slug === 'potassium'
          ? {
              data: {
                supplement: { id: 'potassium', name: 'Potassium', slug: 'potassium' },
                drugInteractions: [
                  { medication: 'Lisinopril', severity: 'severe', description: 'Hyperkalemia risk' },
                ],
              },
            }
          : { data: { supplement: { id: slug, name: slug, slug }, drugInteractions: [] } };
      return Promise.resolve(jsonRes(body));
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await interactions.handler({
      supplements: ['magnesium', 'potassium'],
      medication: 'lisinopril',
    });
    expect(r.mode).toBe('medication');
    if (r.mode !== 'medication') return;
    expect(r.results).toHaveLength(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('supplement=potassium') && u.includes('medication=lisinopril'))).toBe(
      true,
    );
  });

  it('formats medication results with severity + a no-interaction note', () => {
    const text = interactions.format.text({
      mode: 'medication',
      medication: 'lisinopril',
      results: [
        { supplement: { id: 'magnesium', name: 'Magnesium', slug: 'magnesium' }, drugInteractions: [] },
        {
          supplement: { id: 'potassium', name: 'Potassium', slug: 'potassium' },
          drugInteractions: [
            { medication: 'Lisinopril', severity: 'severe', description: 'Hyperkalemia risk' },
          ],
        },
      ],
    } as never);
    expect(text).toContain('Interactions with lisinopril');
    expect(text).toContain('Magnesium');
    expect(text).toContain('no known interaction');
    expect(text).toContain('severe');
    expect(text).toContain('Hyperkalemia risk');
    expect(text).toContain('not medical advice');
  });

  it('rejects a single supplement without --medication', () => {
    expect(() => interactions.inputSchema.parse({ supplements: ['magnesium'] })).toThrow(/2\+|medication/);
  });

  it('allows a single supplement WITH --medication', () => {
    expect(() =>
      interactions.inputSchema.parse({ supplements: ['magnesium'], medication: 'aspirin' }),
    ).not.toThrow();
  });
});
