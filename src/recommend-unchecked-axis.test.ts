import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRecommend } from './recommend';

/**
 * ⚠️ THE NOTE REACHED THE PAYLOAD AND THE CLIENT THREW IT AWAY.
 *
 * `recommend.ts` attaches a warning when an entry's verdict turns on an axis the
 * caller's profile has never stated — `beta-carotene` and smoking status. It is
 * honestly `severity: 'info'`, because an unanswered question is not a finding.
 *
 * This renderer showed `moderate` and above. So the note was computed, sent, and
 * dropped before a single reader saw it: round 48's rule — a capability added to
 * a shared source with nothing checking the CONSUMER uses it — committed in the
 * same session that was fixing three earlier instances of it.
 *
 * The fix is to branch on KIND before rank. Ranking is right for findings; a
 * thing nobody looked at is not one. This test is the consumer-side proof that
 * a source grep would not have given.
 */

const UNCHECKED = "This entry's verdict depends on smoking status, which this profile has never stated.";
const LOW_FINDING = 'A mild note nobody needs to act on.';

type TestWarning = { type: string; severity: string | null; ungraded?: boolean; message: string };

function rec(warnings: TestWarning[]) {
  return {
    supplement: {
      id: 'beta-carotene',
      slug: 'beta-carotene',
      name: 'Beta-Carotene',
      evidence: { score: 2 },
      safety: {},
    },
    scores: { composite: 40 },
    goalBreakdown: [
      { goalId: 'tanning-skin-darkening', goalName: 'Tanning', relevanceScore: 15, isPrimaryMatch: true },
    ],
    warnings,
  };
}

let home: string;
let written: string[];
let restore: () => void;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-unchecked-'));
  process.env.SUPSTACK_HOME = home;
  process.env.SUPSTACK_TOKEN = 'test-token';
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'test-token' }));

  written = [];
  const original = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  restore = () => {
    spy.mockRestore();
    void original;
  };
});

afterEach(() => {
  restore();
  rmSync(home, { recursive: true, force: true });
  delete process.env.SUPSTACK_TOKEN;
});

function mockApi(warnings: TestWarning[]) {
  const body = {
    data: { recommendations: [rec(warnings)] },
    meta: { goals: [{ id: 'tanning-skin-darkening', name: 'Tanning' }], stack: [], totalRecommendations: 1 },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as unknown as Response),
  );
}

describe('supstack recommend shows what could not be checked', () => {
  it('⚠️ prints the unchecked-axis note even though it is below the severity cut', async () => {
    mockApi([{ type: 'unchecked-axis', severity: 'info', message: UNCHECKED }]);
    await runRecommend(5, false);
    expect(written.join(''), 'the note was dropped by the severity filter').toContain(UNCHECKED);
  });

  it('⚠️ and still hides an ordinary low-severity finding, so the fix is not "show everything"', () => {
    // The severity ranking is correct for findings and stays. If this starts
    // passing, the fix has degenerated into removing the filter.
    mockApi([{ type: 'safety', severity: 'info', message: LOW_FINDING }]);
    return runRecommend(5, false).then(() => {
      expect(written.join('')).not.toContain(LOW_FINDING);
    });
  });

  it('a real finding is still printed', async () => {
    mockApi([{ type: 'safety', severity: 'moderate', message: 'Not advised if you smoke.' }]);
    await runRecommend(5, false);
    expect(written.join('')).toContain('Not advised if you smoke.');
  });

  it('⚠️ an unknown severity is still shown — a client must not fail quiet on safety', () => {
    mockApi([{ type: 'safety', severity: 'catastrophic', message: 'Something new and bad.' }]);
    return runRecommend(5, false).then(() => {
      expect(written.join('')).toContain('Something new and bad.');
    });
  });
});

/**
 * ⚠️ THE SECOND CLI RESIDUAL FROM THE 2026-09-06 RECHECK, closed here because
 * their objection was precisely that no test crossed the route into this
 * consumer: "Runtime happens to show null as an unknown severity, but the
 * contract is wrong and no real ungraded recommendation test crosses the route."
 *
 * The API emits `{ severity: null, ungraded: true }` for a row nobody graded.
 * `atLeastModerate(null)` returns true through the unknown-severity escape
 * hatch above — so the warning WAS shown, which is right, but shown with the
 * graded marker, which is not. Being visible and being graded are different
 * claims, and the renderer was making both.
 */
describe('an ungraded warning is shown, and not shown as a grade', () => {
  const UNGRADED = 'Bee Pollen: possible interaction with warfarin';

  it('⚠️ reaches the reader — an ungraded row must never be silently dropped', async () => {
    mockApi([{ type: 'interaction', severity: null, ungraded: true, message: UNGRADED }]);
    await runRecommend(5, false);
    expect(written.join('')).toContain(UNGRADED);
  });

  it('⚠️ says it is not graded, and does not wear the graded marker', async () => {
    mockApi([{ type: 'interaction', severity: null, ungraded: true, message: UNGRADED }]);
    await runRecommend(5, false);
    const text = written.join('');
    expect(text, 'the reader must be told no grade was assigned').toMatch(/not graded/i);
    expect(text, 'the graded marker would read as a clinical verdict').not.toContain('\u26A0');
  });

  it('a genuinely graded warning keeps the graded marker, so this is not "drop the marker"', async () => {
    mockApi([{ type: 'interaction', severity: 'moderate', message: 'Interacts with warfarin.' }]);
    await runRecommend(5, false);
    const text = written.join('');
    expect(text).toContain('Interacts with warfarin.');
    expect(text).toContain('\u26A0');
    expect(text).not.toMatch(/not graded/i);
  });
});
