import { describe, expect, it } from 'vitest';

import { compare } from './capabilities/compare';
import { define } from './capabilities/define';
import { interactions } from './capabilities/interactions';
import { research } from './capabilities/research';
import { search } from './capabilities/search';
import { studies } from './capabilities/studies';

/**
 * Live integration tests against the real public API (https://supstack.me/api/v1).
 *
 * Skipped by default — they hit the network and would be flaky in CI. Run with:
 *   npm run test:integration
 * (sets SUPSTACK_INTEGRATION=1). Override the target with SUPSTACK_API_URL.
 *
 * These assert response *shape* (the contract the CLI parses), not exact content,
 * so they stay stable as the dataset grows.
 */
const RUN = Boolean(process.env.SUPSTACK_INTEGRATION);
const T = 20_000;

describe.skipIf(!RUN)('live API integration', () => {
  it(
    'define returns a term + definition',
    async () => {
      const d = await define.handler({ term: 'adaptogen' });
      expect(d.term.toLowerCase()).toContain('adaptogen');
      expect(d.definition.length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    'search (query) returns ranked hits',
    async () => {
      const hits = await search.handler({ query: 'magnesium', limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.slug === 'magnesium')).toBe(true);
    },
    T,
  );

  it(
    'search (filter) returns supplements with evidence scores',
    async () => {
      const hits = await search.handler({ type: 'mineral', evidence: 'strong', limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(typeof hits[0]?.evidenceScore).toBe('number');
    },
    T,
  );

  it(
    'compare returns the requested supplements + winners',
    async () => {
      const d = await compare.handler({ a: 'magnesium', b: 'glycine' });
      expect(d.supplements).toHaveLength(2);
      expect(d.comparison.evidence).toBeDefined();
    },
    T,
  );

  it(
    'studies returns peer-reviewed results',
    async () => {
      const { studies: rows } = await studies.handler({ query: 'sleep', sort: 'newest', limit: 3 });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.title.length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    'research composes detail + safety',
    async () => {
      const r = await research.handler({ slug: 'ashwagandha' });
      expect(r.detail.slug).toBe('ashwagandha');
      expect(r.safety?.overallRating).toBeTruthy();
    },
    T,
  );

  it(
    'interactions --pathway analyses a pair',
    async () => {
      const r = await interactions.handler({ supplements: ['caffeine', 'l-theanine'], pathway: true });
      expect(r.mode).toBe('pathway');
    },
    T,
  );
});
