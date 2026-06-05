import { afterEach, describe, expect, it, vi } from 'vitest';

import { define, DefinitionSchema } from './define';

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('define capability', () => {
  it('rejects an empty term at the input boundary', () => {
    expect(define.inputSchema.safeParse({ term: '' }).success).toBe(false);
    expect(define.inputSchema.safeParse({ term: 'bioavailability' }).success).toBe(true);
  });

  it('parses the API { data } envelope into a Definition', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        data: {
          term: 'Adaptogen',
          definition: 'A substance that helps the body resist stressors.',
          aliases: ['adaptogenic herb'],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await define.handler({ term: 'adaptogen' });

    expect(out).toEqual({
      term: 'Adaptogen',
      definition: 'A substance that helps the body resist stressors.',
      aliases: ['adaptogenic herb'],
    });
    // Hit the right endpoint with the term query param.
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('/definitions');
    expect(calledUrl).toContain('term=adaptogen');
  });

  it('defaults aliases to [] when the API omits them', () => {
    const parsed = DefinitionSchema.parse({ term: 'RCT', definition: 'Randomised controlled trial.' });
    expect(parsed.aliases).toEqual([]);
  });

  it('renders human text with term, definition, and aliases', () => {
    const text = define.format.text({
      term: 'Bioavailability',
      definition: 'The fraction absorbed.',
      aliases: ['F'],
    });
    expect(text).toContain('Bioavailability');
    expect(text).toContain('The fraction absorbed.');
    expect(text).toContain('Also known as: F');
  });
});
