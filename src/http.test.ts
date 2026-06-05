import { describe, expect, it, vi } from 'vitest';

import { ApiError, apiGet } from './http';

function res(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

const noSleep = async (): Promise<void> => undefined;

describe('apiGet', () => {
  it('returns parsed JSON on success and sends X-API-Key when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ data: { ok: true } }, 200));
    const out = await apiGet<{ data: { ok: boolean } }>('/ping', {
      fetchImpl,
      apiKey: 'key_123',
      baseUrl: 'https://example.test/api/v1',
    });
    expect(out.data.ok).toBe(true);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('key_123');
  });

  it('retries on 429 then succeeds, respecting maxRetries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res({ error: 'rate limited' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(res({ data: 1 }, 200));
    const out = await apiGet('/x', { fetchImpl, sleepImpl: noSleep, baseUrl: 'https://example.test/api/v1' });
    expect(out).toEqual({ data: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws ApiError with the API error message on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ error: 'No definition found' }, 404));
    await expect(
      apiGet('/definitions', { fetchImpl, query: { term: 'nope' }, baseUrl: 'https://example.test/api/v1' }),
    ).rejects.toMatchObject({ status: 404, message: 'No definition found' });
  });

  it('gives up after maxRetries on persistent 500s', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({}, 500));
    await expect(
      apiGet('/x', { fetchImpl, sleepImpl: noSleep, maxRetries: 2, baseUrl: 'https://example.test/api/v1' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
