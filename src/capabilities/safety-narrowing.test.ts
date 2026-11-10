import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addToStack } from '../storage';
import { compare } from './compare';
import { exportStack } from './export';

/**
 * Round 187 — the behavioural half of the safety-narrowing fix.
 *
 * Round 186 found `research`'s zod schema stripping the pregnancy verdicts and
 * fixed only that file. `compare` and `export` had the same shape.
 *
 * ⚠️ These tests exist because the SOURCE-TEXT versions I wrote first did not
 * work. Checking `src.includes('contraindications')` passed even after the
 * schema field was deleted, because the formatter still mentioned the word —
 * and passed after the render was disabled, because the string survived inside
 * the dead branch. Both mutations were applied and both "survived": a
 * file-level substring is not a test of a field. Running the real parse and the
 * real formatter is, and both mutations fail here.
 */

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

const CONTRA = 'Contraindicated — exogenous hormones may cause birth defects';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-narrowing-'));
  process.env.SUPSTACK_HOME = home;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('compare keeps and shows the safety fields the endpoint sends', () => {
  const payload = {
    data: {
      supplements: [
        {
          slug: 'dhea',
          name: 'DHEA',
          evidence: { score: 5 },
          safety: {
            overallRating: 'caution',
            contraindications: [CONTRA],
            pregnancyRecommendation: 'Contraindicated in pregnancy',
          },
        },
        { slug: 'creatine', name: 'Creatine', evidence: { score: 9 }, safety: { overallRating: 'high' } },
      ],
      comparison: {
        evidence: { winner: 'Creatine' },
        safety: { winner: 'Creatine' },
        totalStudies: { winner: 'Creatine' },
      },
    },
  };

  it('does not strip them at parse time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(payload)));
    const r = await compare.handler({ a: 'dhea', b: 'creatine' });
    // zod strips undeclared keys, so this is the whole finding in one assertion.
    expect(r.supplements[0]?.safety?.contraindications).toEqual([CONTRA]);
    expect(r.supplements[0]?.safety?.pregnancyRecommendation).toBe('Contraindicated in pregnancy');
  });

  it('prints them next to the supplement they belong to', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(payload)));
    const text = compare.format.text(await compare.handler({ a: 'dhea', b: 'creatine' }));
    expect(text).toContain(CONTRA);
    expect(text).toContain('Pregnancy: Contraindicated in pregnancy');
  });

  it('says nothing extra for a supplement with nothing to say', async () => {
    // ⚠️ Anti-vacuity for the fix. Printing a notice unconditionally would pass
    // both assertions above while burying the ones that matter — the
    // over-warning failure rounds 126/127 checked for.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(payload)));
    const text = compare.format.text(await compare.handler({ a: 'dhea', b: 'creatine' }));
    const creatineBlock = text.slice(text.indexOf('Creatine'));
    expect(creatineBlock).not.toContain('⛔');
  });
});

describe('an exported document carries the contraindication', () => {
  it('writes it into the markdown', async () => {
    addToStack('dhea');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: {
            slug: 'dhea',
            name: 'DHEA',
            evidence: { score: 5 },
            safety: { overallRating: 'caution', contraindications: [CONTRA] },
          },
        }),
      ),
    );
    const md = exportStack.format.text(await exportStack.handler({ format: 'md' }));
    expect(md).toContain('**Safety:** caution');
    // A one-word rating was the entire safety record of this document before.
    expect(md).toContain('Do not take if');
    expect(md).toContain(CONTRA);
  });

  it('omits the line when there is no contraindication', async () => {
    addToStack('creatine');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: {
            slug: 'creatine',
            name: 'Creatine',
            evidence: { score: 9 },
            safety: { overallRating: 'high' },
          },
        }),
      ),
    );
    const md = exportStack.format.text(await exportStack.handler({ format: 'md' }));
    expect(md).toContain('**Safety:** high');
    expect(md).not.toContain('Do not take if');
  });
});
