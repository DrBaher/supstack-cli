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
                  {
                    medication: 'Lisinopril',
                    severity: 'severe',
                    reviewState: 'reviewed',
                    description: 'Hyperkalemia risk',
                  },
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
      // ⚠️ `assessmentState` is REQUIRED on this result now, and its absence
      // here is why this fixture used to prove the wrong thing: it produced a
      // green "no known interaction" from a shape carrying no assessment at
      // all. The route always sends the state; a fixture that omits it was
      // testing a payload the server does not produce.
      assessmentState: 'clear',
      results: [
        { supplement: { id: 'magnesium', name: 'Magnesium', slug: 'magnesium' }, drugInteractions: [] },
        {
          supplement: { id: 'potassium', name: 'Potassium', slug: 'potassium' },
          drugInteractions: [
            {
              medication: 'Lisinopril',
              severity: 'severe',
              reviewState: 'reviewed',
              description: 'Hyperkalemia risk',
            },
          ],
        },
      ],
    } as never);
    expect(text).toContain('Interactions with lisinopril');
    expect(text).toContain('Magnesium');
    // Pharmacist ruling 263 (7 October 2026): her coverage sentence, not "no known interaction".
    expect(text).toContain('No documented interaction was found in the data searched.');
    expect(text).not.toContain('no known interaction');
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

describe('interactions --route (owner ruling 192.2)', () => {
  it('sends the stated form and prints the server clarification when the form is unknown', async () => {
    const fetchMock = vi.fn((url: string) => {
      const u = new URL(String(url));
      const routed = u.searchParams.get('route') === 'injection';
      return Promise.resolve(
        jsonRes({
          data: {
            supplement: { id: 'calcium', name: 'Calcium', slug: 'calcium' },
            drugInteractions: routed
              ? []
              : [
                  {
                    medication: 'Bisphosphonates (alendronate, risedronate)',
                    severity: 'moderate',
                    reviewState: 'authored',
                    description:
                      'This advice depends on whether you take ibandronate as a tablet or have it as an injection.',
                    routes: ['oral'],
                    routeClarification: 'Do you take ibandronate as a tablet or have it as an injection?',
                  },
                ],
          },
          meta: { assessmentState: routed ? 'clear' : 'graded' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const routed = await interactions.handler({
      supplements: ['calcium'],
      medication: 'ibandronate',
      route: 'injection',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('route=injection');
    expect(routed.mode).toBe('medication');

    const unknown = await interactions.handler({ supplements: ['calcium'], medication: 'ibandronate' });
    const text = interactions.format.text(unknown);
    expect(text).toContain('Do you take ibandronate as a tablet');
  });

  it('rejects a route the API does not know', () => {
    // `nasal` became a real route with pharmacist ruling 209 (6 October 2026).
    expect(
      interactions.inputSchema.safeParse({ supplements: ['calcium'], medication: 'x', route: 'rectal' })
        .success,
    ).toBe(false);
  });
});
