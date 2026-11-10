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
        /**
         * ⚠️ Round 187, completing round 186. That round found this exact shape
         * in `research.ts` and fixed only that file — the failure CLAUDE.md
         * documents ("fixed where it was noticed"). `/compare` returns the FULL
         * corpus entries (`supplements: found`), whose safety block carries 14
         * keys; this schema kept ONE, and zod strips the rest at runtime.
         *
         * A head-to-head is where the stripping hurts most: the tool answers
         * "which should I take", and a pregnant caller got a winner badge plus a
         * single word, with dhea's "Contraindicated — exogenous hormones may
         * cause birth defects" removed.
         */
        safety: z
          .object({
            overallRating: z.string().optional(),
            contraindications: z.array(z.string()).optional(),
            warnings: z.array(z.string()).optional(),
            pregnancyCategory: z.string().nullish(),
            pregnancyRecommendation: z.string().nullish(),
            lactationCategory: z.string().nullish(),
          })
          .optional(),
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
      "Compare 2 or 3 supplements head-to-head by evidence score, safety rating, and total studies. Pass supplement slugs (a, b, optional c). Returns each supplement's key metrics and the winner per category, plus each one's contraindications and pregnancy/lactation notes — the safety WINNER is a one-word rating comparison and is not a verdict for any particular caller, so read the per-supplement safety fields before recommending either.",
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
          m.push(`evidence ${s.evidence.score}/10${s.evidence.level ? ` (${s.evidence.level})` : ''}`);
        }
        if (s.evidence?.totalStudies !== undefined) m.push(`${s.evidence.totalStudies} studies`);
        if (s.safety?.overallRating) m.push(`safety: ${s.safety.overallRating}`);
        // A one-word rating is not a comparison of safety. The contraindication
        // and the pregnancy line are what distinguish two supplements for a
        // reader who has a reason to care.
        const notes: string[] = [];
        for (const c of s.safety?.contraindications ?? []) notes.push(`  ⛔ ${c}`);
        if (s.safety?.pregnancyRecommendation) {
          notes.push(`  ⚠ Pregnancy: ${s.safety.pregnancyRecommendation}`);
        }
        return `${bold(s.name)} ${dim(s.slug)}\n  ${m.join('  ·  ')}${
          notes.length ? `\n${notes.join('\n')}` : ''
        }`;
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
