import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotLoggedInError } from './cloud-stack';
import { getAdherence, localToday, logIntake, runAdherence, runTrackLog } from './track';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Capture stdout written during an async run* call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((s: string): boolean => {
    lines.push(String(s));
    return true;
  }) as any;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
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
    expect(String(url)).toContain('&today='); // passes local date for TZ alignment
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('runAdherence renders overall %, streak, and per-supplement', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: {
            days: 30,
            scheduledDoses: 60,
            takenDoses: 45,
            rate: 0.75,
            streak: 4,
            stackSize: 2,
            perSupplement: [
              { slug: 'caffeine', takenDays: 12, rate: 0.4 },
              { slug: 'magnesium', takenDays: 27, rate: 0.9 },
            ],
          },
        }),
      ),
    );
    const out = await captureStdout(() => runAdherence(30, false));
    expect(out).toContain('Adherence');
    expect(out).toContain('75%'); // overall
    expect(out).toContain('45/60'); // doses
    expect(out).toContain('4 days'); // streak
    expect(out).toContain('caffeine'); // worst-first
    vi.unstubAllGlobals();
  });

  it('runTrackLog prints a confirmation', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonRes({ data: { date: '2026-06-05', status: 'taken', logged: 1, supplements: ['magnesium'] } }),
        ),
    );
    const out = await captureStdout(() => runTrackLog('magnesium', {}, false));
    expect(out).toContain('Logged magnesium for 2026-06-05');
    vi.unstubAllGlobals();
  });
});
