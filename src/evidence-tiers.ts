/**
 * Evidence-tier boundaries, as the SupStack site defines them.
 *
 * The canonical implementation is `evidenceTier()` in the app repo's
 * `src/lib/evidence.ts` (the `evidence.level` invariant on the Supplement type):
 *
 *   >= 8.5  Very Strong
 *   >= 7    Strong
 *   >= 5    Moderate
 *   >= 3    Emerging   (3.0 is EVIDENCE_SCORE_FLOOR)
 *   <  3    Unscored   (the API returns no number at all)
 *
 * The CLI is a separately published package and does not import the app's
 * `src/`, so the numbers are restated here ONCE. Nothing else in the CLI may
 * hard-code a tier threshold. `evidence-tiers.test.ts` pins these values, and
 * the app repo's `tests/data/evidence-tier-parity.test.ts` reads this file and
 * fails if it stops agreeing with `evidenceTier()`.
 *
 * This file exists because `supstack search --evidence strong` once sent
 * `minEvidence=6` (Moderate entries let through) on a 4/6/8 mapping the site
 * had already dropped.
 */

export type EvidenceLevel = 'emerging' | 'moderate' | 'strong' | 'very-strong';

/** Lowest score in each tier. `emerging` starts at the scoring floor. */
export const EVIDENCE_TIER_MIN: Readonly<Record<EvidenceLevel, number>> = {
  emerging: 3,
  moderate: 5,
  strong: 7,
  'very-strong': 8.5,
};

/** The tier a numeric score falls in, or `undefined` below the floor. */
export function evidenceLevelOf(score: number): EvidenceLevel | undefined {
  if (score >= EVIDENCE_TIER_MIN['very-strong']) return 'very-strong';
  if (score >= EVIDENCE_TIER_MIN.strong) return 'strong';
  if (score >= EVIDENCE_TIER_MIN.moderate) return 'moderate';
  if (score >= EVIDENCE_TIER_MIN.emerging) return 'emerging';
  return undefined;
}
