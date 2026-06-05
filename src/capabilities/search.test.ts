import { afterEach, describe, expect, it, vi } from 'vitest';

import { search } from './search';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('search capability', () => {
  it('uses the suggest endpoint for a bare query and normalises hits', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ data: [{ slug: 'magnesium', name: 'Magnesium', type: 'mineral', matchScore: 100 }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const hits = await search.handler({ query: 'magnes', limit: 10, sort: undefined } as never);

    expect(hits).toEqual([{ slug: 'magnesium', name: 'Magnesium', type: 'mineral', matchScore: 100 }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/search/suggest');
  });

  it('uses the list endpoint when filters are present and maps minEvidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        data: [
          {
            slug: 'creatine',
            name: 'Creatine',
            type: 'amino-acid',
            evidence: { score: 9, level: 'very-strong' },
            safety: { overallRating: 'high' },
          },
        ],
        meta: { total: 1 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const hits = await search.handler({ evidence: 'strong', limit: 5 } as never);

    expect(hits[0]).toMatchObject({ slug: 'creatine', evidenceScore: 9, safety: 'high' });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/supplements');
    expect(url).toContain('minEvidence=6'); // strong → 6
  });
});
