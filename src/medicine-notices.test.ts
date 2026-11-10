import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { interactions } from './capabilities/interactions';
import { stack } from './capabilities/stack';
import { AUTHED_TOOLS } from './mcp-authed';
import { runRecommend } from './recommend';
import { addToStack } from './storage';
import { logIntake, runTrackLog } from './track';

/**
 * Pharmacist rulings 197.3 and 197.2, on every authed and anonymous surface
 * the CLI and the MCP server render.
 *
 * The API sends two sentences about the caller's MEDICINES, once per response:
 * `meta.coverageNotice` (a medicine no row covers, such as pamidronate) and
 * `meta.medicineNotices` (the kidney precaution before each injected
 * bisphosphonate dose). The CLI printed the first on `interactions` only and
 * dropped both on `/me/stack`, `/me/track` and `/me/recommend`.
 */

const COVERAGE =
  'We have not checked pamidronate for interactions, because our medicine catalogue does not cover this medicine. This is not a "no interactions found" result. Ask a pharmacist to review it with your supplements.';
const KIDNEY =
  'Before each injected bisphosphonate dose, the treatment team must review kidney function, hydration and relevant medicines according to the exact product’s label. Tell them about kidney disease, dehydration and all medicines/supplements before treatment. Do not change the infusion plan yourself.';
const META = { coverageNotice: COVERAGE, medicineNotices: [KIDNEY] };

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string): boolean => {
    lines.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

const cloud = {
  stackId: 's1',
  name: 'My Stack',
  supplements: [
    { slug: 'calcium', dosage: null, timing: null, notes: null, brandName: null, position: 0 },
    { slug: 'magnesium', dosage: null, timing: null, notes: null, brandName: null, position: 1 },
  ],
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-notices-'));
  process.env.SUPSTACK_HOME = home;
  process.env.SUPSTACK_TOKEN = 'sct_live_x';
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('stack pull / push / sync (/me/stack)', () => {
  it.each(['pull', 'push', 'sync'] as const)(
    '%s keeps both notices on the result and prints each once',
    async (action) => {
      addToStack('calcium');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonRes({ data: cloud, meta: META })),
      );
      const r = await stack.handler({ action });
      expect(r.coverageNotice).toBe(COVERAGE);
      expect(r.medicineNotices).toEqual([KIDNEY]);
      const text = stack.format.text(r);
      expect(count(text, COVERAGE)).toBe(1);
      expect(count(text, KIDNEY)).toBe(1);
      // `--json` and the MCP tool read the same object.
      expect(JSON.stringify(stack.format.json(r))).toContain('medicineNotices');
    },
  );

  it('prints nothing extra when the server sends neither', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ data: cloud })),
    );
    const r = await stack.handler({ action: 'pull' });
    expect(r.coverageNotice).toBeUndefined();
    expect(r.medicineNotices).toBeUndefined();
    expect(stack.format.text(r)).not.toContain('⚠');
  });
});

describe('track log (/me/track)', () => {
  const body = {
    data: { date: '2026-10-05', status: 'taken', logged: 1, supplements: ['calcium'] },
    meta: { warnings: [{ slug: 'calcium', warnings: ['A flagged line'] }], ...META },
  };

  it('logIntake keeps them, so the MCP tool relays them', async () => {
    const r = await logIntake(
      { supplement: 'calcium' },
      vi.fn().mockResolvedValue(jsonRes(body)) as unknown as typeof fetch,
    );
    expect(r.coverageNotice).toBe(COVERAGE);
    expect(r.medicineNotices).toEqual([KIDNEY]);
  });

  it('the terminal prints the warnings and each notice once', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(body)));
    const out = await captureStdout(() => runTrackLog('calcium', {}, false));
    expect(out).toContain('A flagged line');
    expect(count(out, COVERAGE)).toBe(1);
    expect(count(out, KIDNEY)).toBe(1);
  });

  it('the MCP track tool returns them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(body)));
    const tool = AUTHED_TOOLS.find((t) => t.name === 'supstack_track_log')!;
    const r = (await tool.handler({ supplement: 'calcium', status: 'taken' })) as {
      medicineNotices?: string[];
    };
    expect(r.medicineNotices).toEqual([KIDNEY]);
    expect(tool.description).toMatch(/medicineNotices/);
  });
});

describe('recommend (/me/recommend)', () => {
  it('prints each notice once, above the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: { recommendations: [] },
          meta: { goals: [], stack: [], totalRecommendations: 0, ...META },
        }),
      ),
    );
    const out = await captureStdout(() => runRecommend(5, false));
    expect(count(out, COVERAGE)).toBe(1);
    expect(count(out, KIDNEY)).toBe(1);
    expect(AUTHED_TOOLS.find((t) => t.name === 'supstack_recommend')!.description).toMatch(/medicineNotices/);
  });
});

describe('interactions --medication (/interactions)', () => {
  it('keeps medicineNotices through the zod parse and prints it once for several supplements', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const slug = new URL(String(url)).searchParams.get('supplement');
        return Promise.resolve(
          jsonRes({
            data: { supplement: { id: slug, name: slug, slug }, drugInteractions: [] },
            meta: { assessmentState: 'clear', medicineNotices: [KIDNEY] },
          }),
        );
      }),
    );
    const r = await interactions.handler({ supplements: ['magnesium', 'zinc'], medication: 'zoledronate' });
    expect(r.mode).toBe('medication');
    if (r.mode !== 'medication') return;
    expect(r.medicineNotices).toEqual([KIDNEY]);
    expect(count(interactions.format.text(r), KIDNEY)).toBe(1);
  });
});
