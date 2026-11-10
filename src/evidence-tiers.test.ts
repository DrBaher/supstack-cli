import { describe, expect, it } from 'vitest';

import { EVIDENCE_TIER_MIN, evidenceLevelOf } from './evidence-tiers';

/**
 * Pins the CLI's copy of the site's evidence tiers (src/lib/evidence.ts in the
 * app repo: >=8.5 Very Strong, >=7 Strong, >=5 Moderate, >=3 Emerging). The
 * app repo's tests/data/evidence-tier-parity.test.ts also reads this file, so
 * a change here that the site did not make fails there too.
 */
describe('evidence tiers', () => {
  it('uses the canonical boundaries', () => {
    expect(EVIDENCE_TIER_MIN).toEqual({
      emerging: 3,
      moderate: 5,
      strong: 7,
      'very-strong': 8.5,
    });
  });

  it('classifies at and just below every boundary', () => {
    const cases: Array<[number, string | undefined]> = [
      [10, 'very-strong'],
      [8.5, 'very-strong'],
      [8.49, 'strong'],
      [7, 'strong'],
      [6.99, 'moderate'],
      [5, 'moderate'],
      [4.99, 'emerging'],
      [3, 'emerging'],
      [2.99, undefined],
      [0, undefined],
    ];
    for (const [score, tier] of cases) {
      expect(evidenceLevelOf(score), `score ${score}`).toBe(tier);
    }
  });
});
