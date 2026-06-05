import { describe, expect, it, vi } from 'vitest';

import { ApiError, apiGet, parseRetryAfter } from './http';

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

  it('aborts a hung request via the timeout signal and retries, then reports a timeout', async () => {
    // A fetch that never resolves until its abort signal fires.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    await expect(
      apiGet('/slow', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: noSleep,
        maxRetries: 1,
        timeoutMs: 5,
        baseUrl: 'https://example.test/api/v1',
      }),
    ).rejects.toMatchObject({ status: 0, message: 'Request timed out after 5ms' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry, each aborted
  });
});

describe('parseRetryAfter', () => {
  it('parses a delay in seconds', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000);
  });
  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
  });
  it('returns null for past dates, zero, and garbage', () => {
    const now = Date.parse('2026-01-01T00:00:10Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBeNull();
    expect(parseRetryAfter('0', 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
