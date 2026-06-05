import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, dim } from '../output';

/** Map a categorical evidence level to the API's numeric `minEvidence` threshold. */
const EVIDENCE_MIN: Record<string, number> = {
  emerging: 0,
  moderate: 4,
  strong: 6,
  'very-strong': 8,
};

const SuggestResponse = z.object({
  data: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      type: z.string(),
      matchScore: z.number().optional(),
    }),
  ),
});

const ListResponse = z.object({
  data: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      type: z.string(),
      evidence: z.object({ score: z.number().optional(), level: z.string().optional() }).optional(),
      safety: z.object({ overallRating: z.string().optional() }).optional(),
    }),
  ),
  meta: z.object({ total: z.number().optional() }).optional(),
});

export interface SupplementHit {
  slug: string;
  name: string;
  type: string;
  evidenceScore?: number;
  evidenceLevel?: string;
  safety?: string;
  matchScore?: number;
}

const InputSchema = z.object({
  query: z.string().optional(),
  goal: z.string().optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  evidence: z.enum(['emerging', 'moderate', 'strong', 'very-strong']).optional(),
  safety: z.enum(['high', 'moderate', 'caution']).optional(),
  sort: z.enum(['evidence', 'name', 'category']).optional(),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export const search = defineCapability({
  name: 'search',
  description: 'Search supplements by name, or filter by goal/category/type/evidence/safety',
  inputSchema: InputSchema,
  cli: {
    command: 'search',
    args: '[query]',
    options: [
      { flags: '-g, --goal <goal>', description: 'Filter by goal id (e.g. deep-sleep)' },
      { flags: '-c, --category <category>', description: 'Filter by category' },
      { flags: '-t, --type <type>', description: 'Filter by supplement type' },
      { flags: '-e, --evidence <level>', description: 'Min evidence: emerging|moderate|strong|very-strong' },
      { flags: '-s, --safety <rating>', description: 'Filter by safety: high|moderate|caution' },
      { flags: '--sort <field>', description: 'Sort: evidence|name|category' },
      { flags: '-n, --limit <n>', description: 'Max results (default 10)' },
    ],
  },
  mcp: {
    toolName: 'supstack_search',
    description:
      'Search the SupStack supplement library. Provide a free-text query to find supplements by name, and/or structured filters (goal id, category, supplement type, minimum evidence level, safety rating). Returns a ranked list with slug, name, type, and evidence score.',
  },
  handler: async (input): Promise<SupplementHit[]> => {
    const hasFilters = Boolean(
      input.goal || input.category || input.type || input.evidence || input.safety || input.sort,
    );

    // Free-text query with no structured filters → fuzzy autocomplete endpoint.
    if (input.query && !hasFilters) {
      const res = await apiGet<unknown>('/search/suggest', {
        query: { q: input.query, limit: input.limit },
      });
      return SuggestResponse.parse(res).data.map((d) => ({
        slug: d.slug,
        name: d.name,
        type: d.type,
        matchScore: d.matchScore,
      }));
    }

    // Otherwise → filtered list endpoint.
    const res = await apiGet<unknown>('/supplements', {
      query: {
        q: input.query,
        goal: input.goal,
        category: input.category,
        type: input.type,
        minEvidence: input.evidence ? EVIDENCE_MIN[input.evidence] : undefined,
        safety: input.safety,
        sort: input.sort ?? 'evidence',
        pageSize: input.limit,
      },
    });
    return ListResponse.parse(res).data.map((d) => ({
      slug: d.slug,
      name: d.name,
      type: d.type,
      evidenceScore: d.evidence?.score,
      evidenceLevel: d.evidence?.level,
      safety: d.safety?.overallRating,
    }));
  },
  format: {
    text: (hits): string => {
      if (hits.length === 0) return dim('No supplements found.');
      return hits
        .map((h) => {
          const meta: string[] = [dim(h.type)];
          if (h.evidenceScore !== undefined) {
            meta.push(`evidence ${h.evidenceScore}${h.evidenceLevel ? ` (${h.evidenceLevel})` : ''}`);
          }
          if (h.safety) meta.push(`safety: ${h.safety}`);
          if (h.matchScore !== undefined) meta.push(dim(`match ${h.matchScore}`));
          return `${bold(h.name)} ${dim(h.slug)}\n  ${meta.join('  ·  ')}`;
        })
        .join('\n');
    },
    json: (hits): unknown => hits,
  },
});
