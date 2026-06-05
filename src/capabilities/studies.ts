import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, dim } from '../output';

const STUDY_TYPES = [
  'rct',
  'meta-analysis',
  'systematic-review',
  'observational',
  'cohort',
  'case-control',
  'in-vitro',
  'animal',
  'pilot',
  'crossover',
  'review',
  'open-label',
  'preclinical',
  'case-study',
] as const;

const Study = z.object({
  title: z.string(),
  journal: z.string().nullish(),
  year: z.number().nullish(),
  study_type: z.string().nullish(),
  supplement_names: z.array(z.string()).optional(),
  doi: z.string().nullish(),
});

const StudiesResponse = z.object({
  data: z.array(Study),
  meta: z.object({ total: z.number().optional() }).optional(),
});

export interface StudiesResult {
  studies: z.infer<typeof Study>[];
  total?: number;
}

const InputSchema = z.object({
  query: z.string().optional(),
  type: z.enum(STUDY_TYPES).optional(),
  supplement: z.string().optional(),
  sort: z.enum(['newest', 'relevance', 'year']).default('newest'),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export const studies = defineCapability({
  name: 'studies',
  description: 'Search the research library of peer-reviewed studies',
  inputSchema: InputSchema,
  cli: {
    command: 'studies',
    args: '[query]',
    options: [
      {
        flags: '-t, --type <type>',
        description: `Study type (e.g. ${STUDY_TYPES.slice(0, 3).join(', ')}, …)`,
      },
      { flags: '-s, --supplement <slug>', description: 'Filter by supplement slug' },
      { flags: '--sort <field>', description: 'Sort: newest|relevance|year (default newest)' },
      { flags: '-n, --limit <n>', description: 'Max results (default 10)' },
    ],
  },
  mcp: {
    toolName: 'supstack_studies',
    description:
      "Search SupStack's research library of peer-reviewed studies. Filter by free-text query, study type (e.g. rct, meta-analysis, systematic-review), and/or supplement slug. Sort by newest, relevance, or year. Returns study titles, journals, years, and study types.",
  },
  handler: async (input): Promise<StudiesResult> => {
    const res = await apiGet<unknown>('/studies', {
      query: {
        q: input.query,
        type: input.type,
        supplement: input.supplement,
        sort: input.sort,
        pageSize: input.limit,
      },
    });
    const parsed = StudiesResponse.parse(res);
    return { studies: parsed.data, total: parsed.meta?.total };
  },
  format: {
    text: ({ studies: rows, total }): string => {
      if (rows.length === 0) return dim('No studies found.');
      const header = total !== undefined ? dim(`${total} matching · showing ${rows.length}`) + '\n\n' : '';
      const body = rows
        .map((s) => {
          const cite = [s.journal, s.year].filter(Boolean).join(', ');
          const tags = [s.study_type, s.supplement_names?.join('/')].filter(Boolean).join('  ·  ');
          return `${bold(s.title)}\n  ${dim(cite)}${tags ? `  [${tags}]` : ''}`;
        })
        .join('\n');
      return header + body;
    },
    json: ({ studies: rows, total }): unknown => ({ total, studies: rows }),
  },
});
