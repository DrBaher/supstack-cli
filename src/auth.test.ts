import { describe, expect, it, vi } from 'vitest';

import { fetchMe, pollDeviceToken, revokeToken, startDeviceLogin } from './auth';

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('auth wire helpers', () => {
  it('startDeviceLogin POSTs a device_name to /auth/device/start', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        device_code: 'd',
        user_code: 'WXYZ-2345',
        verification_uri: 'https://x/activate',
        verification_uri_complete: 'https://x/activate?code=WXYZ-2345',
        interval: 5,
        expires_in: 600,
      }),
    );
    const out = await startDeviceLogin(fetchImpl as unknown as typeof fetch);
    expect(out.user_code).toBe('WXYZ-2345');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/auth/device/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).device_name).toContain('SupStack CLI');
  });

  it('pollDeviceToken returns the status payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ status: 'complete', access_token: 'sct_live_x' }));
    const out = await pollDeviceToken('dev', fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ status: 'complete', access_token: 'sct_live_x' });
  });

  it('fetchMe sends Bearer and unwraps the data envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ data: { id: 'u1', email: 'a@b.c', displayName: null, goals: [] } }));
    const me = await fetchMe('sct_live_x', fetchImpl as unknown as typeof fetch);
    expect(me.email).toBe('a@b.c');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('revokeToken POSTs to /auth/logout with Bearer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ status: 'revoked' }));
    await revokeToken('sct_live_x', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/auth/logout');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });
});
