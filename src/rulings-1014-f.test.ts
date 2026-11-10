/**
 * Group F of the pharmacist's 495-555 response (14 October 2026) in the CLI:
 * `supstack experiments show` prints her W548 when the server marks a frozen
 * schedule as historical (ruling 548), and the safety display version of each
 * stored answer, "version not recorded" for one stored before it was kept
 * (owner call O-4). The MCP server relays the same JSON unchanged.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runExperimentShow } from './experiments';

const W548 =
  'This schedule was saved when the experiment began. It is not evidence that this product needs that duration or will work by then. Follow the current safety instructions; do not wait for the scheduled review if a warning sign occurs.';
const ID = '8b03297e-0000-4000-8000-0000000f1014';

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string): boolean => (lines.push(String(s)), true)) as never;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-1014f-'));
  process.env.SUPSTACK_HOME = home;
  process.env.SUPSTACK_TOKEN = 'sct_live_x';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

const answer = (n: number, version?: string) => ({
  type: 'check-in',
  checkInNumber: n,
  questionId: 'red-flag-signs',
  questionText: 'Warning signs',
  category: 'safety',
  value: 'none',
  respondedAt: '2026-10-05T09:00:00Z',
  ...(version ? { safetyDisplayVersion: version } : {}),
});

describe('experiments show on a frozen experiment', () => {
  it('prints W548 and each answer\'s version, or "version not recorded"', async () => {
    const detail = {
      id: ID,
      supplement: { slug: 'green-tea-extract', name: 'Green Tea Extract' },
      goal: { id: 'sharpen-focus', name: 'Sharpen focus' },
      status: 'active',
      verdict: null,
      verdictSummary: null,
      progress: { completed: 2, expected: 4 },
      startedAt: '2026-10-01T00:00:00Z',
      completedAt: null,
      nextCheckInDate: '2026-10-20T00:00:00Z',
      safetyAction: null,
      verdictDetails: null,
      baselineCompletedAt: null,
      protocol: { protocol: { historicalScheduleNote: W548 } },
      safetyDisplay: { version: 'fsd2-0123abcd', source: 'live' },
      responses: [answer(1, 'version not recorded'), answer(2, 'fsd2-0123abcd'), answer(2)],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: detail }),
      } as unknown as Response),
    );
    const out = await captureStdout(() => runExperimentShow(ID, false));
    expect(out).toContain(W548);
    expect(out).toContain('(safety text version: version not recorded)');
    expect(out).toContain('(safety text version: fsd2-0123abcd)');
    // An older server that sends no version reads as not recorded too.
    expect(out.split('version not recorded').length - 1).toBe(2);
  });
});
