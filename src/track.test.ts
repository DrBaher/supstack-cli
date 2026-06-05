import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotLoggedInError } from './cloud-stack';
import { getAdherence, localToday, logIntake } from './track';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-track-'));
  process.env.SUPSTACK_HOME = home;
  delete process.env.SUPSTACK_TOKEN;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('track', () => {
  it('requires a token', async () => {
    await expect(logIntake({ supplement: 'magnesium' })).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(getAdherence(30)).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('localToday formats the local date as YYYY-MM-DD', () => {
    expect(localToday(new Date(2026, 5, 3))).toBe('2026-06-03'); // month is 0-indexed → June
  });

  it('logIntake POSTs /me/track with the body + Bearer', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ data: { date: '2026-06-03', status: 'taken', logged: 1, supplements: ['magnesium'] } }),
      );
    const out = await logIntake(
      { supplement: 'magnesium', date: '2026-06-03', status: 'taken' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(out.logged).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/track');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      supplement: 'magnesium',
      date: '2026-06-03',
      status: 'taken',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('getAdherence GETs /me/adherence with days + Bearer', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          days: 7,
          scheduledDoses: 21,
          takenDoses: 18,
          rate: 0.86,
          streak: 3,
          stackSize: 3,
          perSupplement: [],
        },
      }),
    );
    const out = await getAdherence(7, fetchImpl as unknown as typeof fetch);
    expect(out.rate).toBe(0.86);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/adherence?days=7');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });
});
