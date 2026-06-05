import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, cyan, dim } from '../output';

const Winner = z.object({
  winner: z.string().nullable(),
  note: z.string().optional(),
});

const CompareResponse = z.object({
  data: z.object({
    supplements: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        evidence: z
          .object({
            score: z.number().optional(),
            level: z.string().optional(),
            totalStudies: z.number().optional(),
          })
          .optional(),
        safety: z.object({ overallRating: z.string().optional() }).optional(),
      }),
    ),
    comparison: z.object({
      evidence: Winner,
      safety: Winner,
      totalStudies: Winner,
    }),
  }),
});

export type CompareResult = z.infer<typeof CompareResponse>['data'];

const InputSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  c: z.string().optional(),
});

export const compare = defineCapability({
  name: 'compare',
  description: 'Compare 2–3 supplements side by side',
  inputSchema: InputSchema,
  cli: { command: 'compare', args: '<a> <b> [c]' },
  mcp: {
    toolName: 'supstack_compare',
    description:
      "Compare 2 or 3 supplements head-to-head by evidence score, safety rating, and total studies. Pass supplement slugs (a, b, optional c). Returns each supplement's key metrics and the winner per category.",
  },
  handler: async ({ a, b, c }): Promise<CompareResult> => {
    const supplements = [a, b, c].filter((s): s is string => Boolean(s)).join(',');
    const res = await apiGet<unknown>('/compare', { query: { supplements } });
    return CompareResponse.parse(res).data;
  },
  format: {
    text: (d): string => {
      const rows = d.supplements.map((s) => {
        const m: string[] = [];
        if (s.evidence?.score !== undefined) {
          m.push(`evidence ${s.evidence.score}${s.evidence.level ? ` (${s.evidence.level})` : ''}`);
        }
        if (s.evidence?.totalStudies !== undefined) m.push(`${s.evidence.totalStudies} studies`);
        if (s.safety?.overallRating) m.push(`safety: ${s.safety.overallRating}`);
        return `${bold(s.name)} ${dim(s.slug)}\n  ${m.join('  ·  ')}`;
      });
      const winner = (label: string, w: z.infer<typeof Winner>): string =>
        `  ${label}: ${w.winner ? cyan(w.winner) : dim(w.note ?? 'tied')}`;
      const winners = [
        winner('Evidence', d.comparison.evidence),
        winner('Safety', d.comparison.safety),
        winner('Total studies', d.comparison.totalStudies),
      ];
      return `${rows.join('\n')}\n\n${bold('Winners')}\n${winners.join('\n')}`;
    },
    json: (d): unknown => d,
  },
});
