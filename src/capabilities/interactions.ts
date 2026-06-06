import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, dim, green, red, yellow } from '../output';

// ─── Standard mode (?supplements=a,b[,c]) ────────────────────────────────────
const StandardResponse = z.object({
  data: z.object({
    supplements: z.array(z.object({ id: z.string(), name: z.string(), safetyRating: z.string().optional() })),
    supplementInteractions: z.array(
      z.object({
        between: z.array(z.string()),
        type: z.string(),
        severity: z.string(),
        description: z.string(),
        combinedBenefit: z.string().optional(),
      }),
    ),
    sharedDrugConcerns: z
      .array(z.object({ medication: z.string(), supplements: z.array(z.string()), concern: z.string() }))
      .default([]),
  }),
});

// ─── Pathway mode (?supplements=a,b&pathway=true) — pair only ─────────────────
const PathwayResponse = z.object({
  data: z.object({
    supplement1: z.string(),
    supplement2: z.string(),
    pathwayAnalysis: z.object({
      type: z.string(),
      score: z.number(),
      confidence: z.number(),
      explanation: z.string(),
      sharedTargets: z
        .array(
          z.object({
            targetName: z.string(),
            targetType: z.string(),
            interactionType: z.string(),
            evidence: z.string(),
          }),
        )
        .default([]),
      mechanisms: z
        .array(z.object({ type: z.string(), description: z.string(), impact: z.string() }))
        .default([]),
    }),
  }),
});

// ─── Medication mode (?supplement=a&medication=drug) — per-supplement drug check ──
const DrugResponse = z.object({
  data: z.object({
    supplement: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
    drugInteractions: z.array(
      z.object({ medication: z.string(), severity: z.string(), description: z.string() }),
    ),
    overallSafetyRating: z.string().optional(),
  }),
});

type StandardData = z.infer<typeof StandardResponse>['data'];
type PathwayData = z.infer<typeof PathwayResponse>['data'];
type DrugData = z.infer<typeof DrugResponse>['data'];

type InteractionsResult =
  | { mode: 'standard'; data: StandardData; pathwaySkipped: boolean }
  | { mode: 'pathway'; data: PathwayData }
  | { mode: 'medication'; medication: string; results: DrugData[] };

const InputSchema = z
  .object({
    supplements: z.array(z.string().min(1)).min(1, 'interactions needs at least 1 supplement'),
    medication: z.string().min(1).optional(),
    pathway: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.medication) || d.supplements.length >= 2, {
    message:
      'interactions needs 2+ supplements (e.g. `magnesium ashwagandha`), or `--medication <drug>` to check one+ supplements against a medication',
    path: ['supplements'],
  });

function severityColor(severity: string): string {
  const s = severity.toLowerCase();
  if (s === 'caution' || s === 'negative') return yellow(severity);
  if (s === 'positive') return green(severity);
  return dim(severity);
}

/** Colour a supplement×drug interaction by clinical severity. */
function drugSeverityColor(severity: string): string {
  const s = severity.toLowerCase();
  if (['critical', 'contraindicated', 'severe', 'major'].includes(s)) return red(severity);
  if (['moderate', 'caution'].includes(s)) return yellow(severity);
  if (s === 'beneficial') return green(severity);
  return dim(severity); // mild, minor, …
}

export const interactions = defineCapability({
  name: 'interactions',
  description: 'Check interactions across supplements, or vs a medication (--medication)',
  inputSchema: InputSchema,
  cli: {
    command: 'interactions',
    args: '<supplements...>',
    options: [
      { flags: '--pathway', description: 'Deep biochemical pathway analysis (exactly 2 supplements)' },
      {
        flags: '-m, --medication <drug>',
        description: 'Check each supplement against a medication (e.g. lisinopril)',
      },
    ],
  },
  mcp: {
    toolName: 'supstack_interactions',
    description:
      'Check interactions for supplements (by slug). With `medication` set, checks EACH supplement against that drug and returns the matching drug-interaction warnings with clinical severity (use this for "does my stack interact with <drug>?"). Otherwise: default mode lists pairwise supplement-supplement interactions and shared drug concerns; set pathway=true with exactly two supplements for a deep biochemical analysis (shared enzyme/receptor targets, mechanisms, synergy/conflict score).',
  },
  handler: async (input): Promise<InteractionsResult> => {
    const slugs = input.supplements;

    // Medication mode: check each supplement against the named drug (per-supplement
    // drug endpoint), so it works for one supplement or a whole stack.
    if (input.medication) {
      const medication = input.medication;
      const results = await Promise.all(
        slugs.map(async (slug) => {
          const res = await apiGet<unknown>('/interactions', { query: { supplement: slug, medication } });
          return DrugResponse.parse(res).data;
        }),
      );
      return { mode: 'medication', medication, results };
    }

    const supplements = slugs.join(',');

    // Pathway analysis is a pair-only engine; for >2 fall back to standard mode.
    if (input.pathway && slugs.length === 2) {
      const res = await apiGet<unknown>('/interactions', { query: { supplements, pathway: 'true' } });
      return { mode: 'pathway', data: PathwayResponse.parse(res).data };
    }

    const res = await apiGet<unknown>('/interactions', { query: { supplements } });
    return {
      mode: 'standard',
      data: StandardResponse.parse(res).data,
      pathwaySkipped: Boolean(input.pathway) && slugs.length !== 2,
    };
  },
  format: {
    text: (r): string => {
      if (r.mode === 'medication') {
        const out: string[] = [bold(`Interactions with ${r.medication}`), ''];
        for (const d of r.results) {
          if (d.drugInteractions.length === 0) {
            out.push(`  ${d.supplement.name}  ${green('no known interaction')}`);
          } else {
            for (const di of d.drugInteractions) {
              out.push(
                `  ${d.supplement.name}  ${drugSeverityColor(di.severity)}  ${dim(`(${di.medication})`)}`,
              );
              out.push(`    ${dim(di.description)}`);
            }
          }
        }
        out.push(
          '',
          dim("Drug-interaction data from each supplement's safety profile — not medical advice."),
        );
        return out.join('\n');
      }
      if (r.mode === 'pathway') {
        const a = r.data.pathwayAnalysis;
        const out = [
          `${bold(`${r.data.supplement1} + ${r.data.supplement2}`)}  ${severityColor(a.type)}`,
          dim(`score ${a.score}/100 · confidence ${a.confidence}/100`),
          '',
          a.explanation,
        ];
        if (a.sharedTargets.length) {
          out.push('', bold('Shared targets'));
          for (const t of a.sharedTargets) {
            out.push(`  ${t.targetName} (${dim(t.targetType)}) — ${t.interactionType} · ${dim(t.evidence)}`);
          }
        }
        if (a.mechanisms.length) {
          out.push('', bold('Mechanisms'));
          for (const m of a.mechanisms) out.push(`  ${m.description} (${dim(m.impact)})`);
        }
        return out.join('\n');
      }

      const out: string[] = [];
      if (r.pathwaySkipped) {
        out.push(dim('(--pathway needs exactly 2 supplements; showing standard analysis)'), '');
      }
      out.push(
        bold('Supplements'),
        ...r.data.supplements.map(
          (s) => `  ${s.name}${s.safetyRating ? dim(`  safety: ${s.safetyRating}`) : ''}`,
        ),
      );
      if (r.data.supplementInteractions.length) {
        out.push('', bold('Interactions'));
        for (const i of r.data.supplementInteractions) {
          out.push(`  ${i.between.join(' + ')}  ${severityColor(i.severity)}`);
          out.push(`    ${dim(i.description)}`);
        }
      } else {
        out.push('', dim('No notable pairwise interactions found.'));
      }
      if (r.data.sharedDrugConcerns.length) {
        out.push('', bold('Shared drug concerns'));
        for (const c of r.data.sharedDrugConcerns) {
          out.push(`  ${c.medication} — ${c.supplements.join(', ')}`);
          out.push(`    ${dim(c.concern)}`);
        }
      }
      return out.join('\n');
    },
    json: (r): unknown => r,
  },
});
