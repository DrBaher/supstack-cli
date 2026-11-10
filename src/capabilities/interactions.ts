import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, dim, green, red, yellow } from '../output';

/**
 * Pharmacist ruling 263 (7 October 2026), her wording (W19), the same sentence
 * as `NO_DOCUMENTED_INTERACTION` in the app's coverage-wording.ts (this package
 * cannot import the app; tests/data/rulings-256-274-group-c.test.ts holds the
 * two equal). Printed for a medicine the library covers and no row reached,
 * when the server sends no `coverageStatement` of its own.
 */
export const NO_DOCUMENTED_INTERACTION =
  'No documented interaction was found in the data searched. This does not establish that this exact combination is safe.';

// ─── Standard mode (?supplements=a,b[,c]) ────────────────────────────────────
/** The fields every supplement-pair row carries, whatever its review state. */
const PairRowBase = z.object({
  between: z.array(z.string()),
  type: z.string(),
  /** `synergies` (an entry's own card, never graded) or `curated`. */
  source: z.string().optional(),
  /** Ruling 152: the tier is a provisional grade, pending clinical review. */
  gradeConfidence: z.literal('provisional').optional(),
  /** Ruling 254: explicit review status. `tier` comes only with `graded`. */
  reviewStatus: z.string().optional(),
  ungradedNote: z.string().optional(),
  tier: z.string().optional(),
  description: z.string(),
  combinedBenefit: z.string().optional(),
  recommendation: z.string().optional(),
});

/**
 * ⚠️ TWO ARMS, not a nullable severity beside a free `reviewState`, which is
 * what once parsed a graded row with no grade. A row with no `reviewState`
 * must carry a severity word. Only an ungraded row may carry none: since
 * 10 October 2026 a synergy card comes as `severity: null` (pharmacist ruling
 * 379 found nothing in those pairs individually graded, and the API had sent
 * every card as `positive`).
 */
const PairRow = z.union([
  PairRowBase.extend({ reviewState: z.undefined().optional(), severity: z.string() }),
  PairRowBase.extend({
    /**
     * ⚠️ CARRIED, because dropping it printed a severity word for a row
     * nobody graded. Zod strips unknown keys, so this schema silently
     * discarded the API's `reviewState` and the CLI rendered `caution` —
     * the route's own word, not a grade — with nothing to say so. Found by
     * exercising the real payload through the real formatter, after the API
     * fix was assumed to propagate.
     */
    reviewState: z.literal('ungraded'),
    severity: z.union([z.string(), z.null()]),
  }),
]);

const StandardResponse = z.object({
  data: z.object({
    supplements: z.array(z.object({ id: z.string(), name: z.string(), safetyRating: z.string().optional() })),
    supplementInteractions: z.array(PairRow),
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
    /**
     * ⚠️ SCORE, CONFIDENCE AND EXPLANATION ARE OPTIONAL, because the route stops
     * sending them for an unsigned pair (2026-09-07 ruling). Leaving them
     * REQUIRED would have thrown a ZodError on exactly those pairs — the same
     * failure as #746, where the public shape changed and one client schema did
     * not, and `supstack research` threw on all 39 supplements with an ungraded
     * row. A client schema is part of the contract, not a reader of it.
     */
    pathwayAnalysis: z.object({
      type: z.string(),
      reviewState: z.literal('ungraded').optional(),
      status: z.string().optional(),
      guidance: z.string().optional(),
      score: z.number().optional(),
      confidence: z.number().optional(),
      explanation: z.string().optional(),
      /** Ruling 152: the entry caution deciding the verdict has a provisional grade. */
      provisionalGrade: z.literal(true).optional(),
      /** Ruling 254: explicit review status, and for a non-graded pair its note. */
      reviewStatus: z.string().optional(),
      note: z.string().optional(),
      pathwayInference: z.string().optional(),
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
    /**
     * ⚠️ A DISCRIMINATED UNION. A nullable severity beside an independent
     * discriminator still PARSES `{ reviewState: 'reviewed', severity: null }`
     * — the 2026-09-04 recheck proved it with a runtime probe. Owner ruling
     * R-005-02 asks for the contradiction to be unrepresentable at every layer;
     * `discriminatedUnion` is zod's version of that.
     */
    drugInteractions: z.array(
      z.discriminatedUnion('reviewState', [
        /**
         * ⚠️ `authored` IS THE GRADED ARM THE API ACTUALLY SENDS. Since
         * 2026-09-08 every graded row is `authored` (editorial, never signed by
         * a clinician) and none is `reviewed`, so a union of `reviewed |
         * ungraded` threw on every graded drug interaction (1 October 2026
         * audit). Both publish their grade.
         */
        z.object({
          reviewState: z.literal('authored'),
          severity: z.string(),
          medication: z.string(),
          /** Ruling 539: the exact label the description is taken from. Carried because zod strips unknown keys. */
          source: z.object({ label: z.string(), url: z.string() }).optional(),
          description: z.string(),
          matchedVia: z.enum(['exact', 'alias', 'component', 'example', 'class']).optional(),
          /**
           * Owner ruling 192.2: the forms of the medication this row applies to,
           * and, when the caller has not said which form it takes, the question
           * that replaces the row's tablet advice. Carried because zod strips
           * unknown keys, and a dropped question would print nothing to answer.
           */
          routes: z.array(z.string()).optional(),
          routeClarification: z.string().optional(),
          /**
           * Pharmacist ruling 152: the grade is provisional, pending clinical
           * review. Carried because zod strips unknown keys, and a dropped
           * marker would print the grade as settled.
           */
          gradeConfidence: z.literal('provisional').optional(),
          provisionalNote: z.string().optional(),
        }),
        z.object({
          reviewState: z.literal('reviewed'),
          severity: z.string(),
          medication: z.string(),
          /** Ruling 539: the exact label the description is taken from. Carried because zod strips unknown keys. */
          source: z.object({ label: z.string(), url: z.string() }).optional(),
          description: z.string(),
          matchedVia: z.enum(['exact', 'alias', 'component', 'example', 'class']).optional(),
          /**
           * Owner ruling 192.2: the forms of the medication this row applies to,
           * and, when the caller has not said which form it takes, the question
           * that replaces the row's tablet advice. Carried because zod strips
           * unknown keys, and a dropped question would print nothing to answer.
           */
          routes: z.array(z.string()).optional(),
          routeClarification: z.string().optional(),
          /**
           * Pharmacist ruling 152: the grade is provisional, pending clinical
           * review. Carried because zod strips unknown keys, and a dropped
           * marker would print the grade as settled.
           */
          gradeConfidence: z.literal('provisional').optional(),
          provisionalNote: z.string().optional(),
        }),
        z.object({
          reviewState: z.literal('ungraded'),
          severity: z.null(),
          medication: z.string(),
          /** Ruling 539: the exact label the description is taken from. Carried because zod strips unknown keys. */
          source: z.object({ label: z.string(), url: z.string() }).optional(),
          description: z.string(),
          ungradedNote: z.string().optional(),
          /** Ruling 254: why no grade is published (`provisional`, `class-term`, `label-note` ...). */
          reviewStatus: z.string().optional(),
          matchedVia: z.enum(['exact', 'alias', 'component', 'example', 'class']).optional(),
          /**
           * Owner ruling 192.2: the forms of the medication this row applies to,
           * and, when the caller has not said which form it takes, the question
           * that replaces the row's tablet advice. Carried because zod strips
           * unknown keys, and a dropped question would print nothing to answer.
           */
          routes: z.array(z.string()).optional(),
          routeClarification: z.string().optional(),
        }),
      ]),
    ),
    overallSafetyRating: z.string().optional(),
  }),
  meta: z
    .object({
      /**
       * ⚠️ The ONLY field this client may render a green result on. An empty
       * `drugInteractions` used to be enough, so `--medication zzz-not-a-drug`
       * printed "no known interaction" for a drug nobody could identify.
       */
      assessmentState: z.enum(['clear', 'ungraded-only', 'graded', 'mixed', 'unassessed']).optional(),
      /**
       * Pharmacist ruling 263 (7 October 2026): coverage and review status in
       * distinct fields. `coverageStatement` is her sentence for a search that
       * found no documented interaction, printed as sent.
       */
      coverage: z.enum(['documented', 'no-documented-interaction', 'not-covered']).optional(),
      coverageStatement: z.string().optional(),
      reviewStatus: z.enum(['graded', 'unvalidated-only', 'mixed']).optional(),
      /**
       * Pharmacist ruling 197.3: the server names a medication no row covers
       * (pamidronate) with the pharmacist route. Carried because zod strips
       * unknown keys, and a dropped notice would print "not assessed" alone.
       */
      coverageNotice: z.string().optional(),
      /**
       * Pharmacist ruling 197.2: notices about the MEDICINE, whatever the
       * supplement (the kidney precaution before each injected bisphosphonate
       * dose). Carried for the same reason: zod strips what it does not declare.
       */
      medicineNotices: z.array(z.string()).optional(),
    })
    .optional(),
});

type StandardData = z.infer<typeof StandardResponse>['data'];
type PathwayData = z.infer<typeof PathwayResponse>['data'];
type DrugData = z.infer<typeof DrugResponse>['data'];

type InteractionsResult =
  | { mode: 'standard'; data: StandardData; pathwaySkipped: boolean }
  | { mode: 'pathway'; data: PathwayData }
  | {
      mode: 'medication';
      medication: string;
      results: DrugData[];
      /**
       * The server's own assessment state — the only basis for a green result.
       *
       * ⚠️ REQUIRED, and normalised at the fetch boundary. It was optional, and
       * the formatter read `undefined` as clear, so a response carrying no meta
       * at all printed "no known interaction" in green. The 2026-09-06 recheck
       * reproduced exactly that. An absent state is now `'unassessed'` before it
       * reaches any renderer, so there is no third value to forget about.
       */
      assessmentState: 'clear' | 'ungraded-only' | 'graded' | 'mixed' | 'unassessed';
      /** Ruling 197.3: the server's catalogue-coverage sentence, when it sent one. */
      coverageNotice?: string;
      /** Ruling 263: the server's no-documented-interaction sentence, when it sent one. */
      coverageStatement?: string;
      /** Ruling 197.2: notices about the medicine, once, however many supplements were queried. */
      medicineNotices?: string[];
    };

const InputSchema = z
  .object({
    supplements: z.array(z.string().min(1)).min(1, 'interactions needs at least 1 supplement'),
    medication: z.string().min(1).optional(),
    /** Ruling 192.2: the form the medication is taken in, where it changes the advice. */
    route: z
      .enum([
        'oral',
        'enteral',
        'injection',
        'transdermal',
        'vaginal',
        'inhaled',
        'nasal',
        'implant',
        'eye',
        'ear',
        'dental',
        'unknown',
      ])
      .optional(),
    formulation: z.enum(['immediate-release', 'delayed-release']).optional(),
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
      {
        flags: '--route <route>',
        description: 'How the medication is taken: oral, injection or transdermal (e.g. ibandronate)',
      },
      {
        flags: '--formulation <formulation>',
        description: 'Oral formulation: immediate-release or delayed-release (e.g. risedronate)',
      },
    ],
  },
  mcp: {
    toolName: 'supstack_interactions',
    description:
      'Check interactions for supplements (by slug). Set `route` (oral, enteral, injection, transdermal, vaginal, inhaled, nasal, implant, eye, ear, dental, unknown) or `formulation` (immediate-release, delayed-release) when the medication comes in more than one form, e.g. ibandronate tablet vs injection; without it, a row limited to one form returns `routeClarification` instead of its advice. With `medication` set, checks EACH supplement against that drug and returns the matching drug-interaction warnings with clinical severity (use this for "does my stack interact with <drug>?"). Otherwise: default mode lists pairwise supplement-supplement interactions and shared drug concerns; set pathway=true with exactly two supplements for a deep biochemical analysis (shared enzyme/receptor targets, mechanisms, synergy/conflict score).',
  },
  handler: async (input): Promise<InteractionsResult> => {
    const slugs = input.supplements;

    // Medication mode: check each supplement against the named drug (per-supplement
    // drug endpoint), so it works for one supplement or a whole stack.
    if (input.medication) {
      const medication = input.medication;
      const parsed = await Promise.all(
        slugs.map(async (slug) => {
          const res = await apiGet<unknown>('/interactions', {
            query: {
              supplement: slug,
              medication,
              ...(input.route ? { route: input.route } : {}),
              ...(input.formulation ? { formulation: input.formulation } : {}),
            },
          });
          return DrugResponse.parse(res);
        }),
      );
      // The strictest state across the queried supplements: if ANY came back
      // unassessed, the whole answer is not clear.
      const states = parsed.map((p) => p.meta?.assessmentState).filter(Boolean);
      return {
        mode: 'medication',
        medication,
        results: parsed.map((p) => p.data),
        // No state at all is NOT clear — it is a response we cannot interpret.
        assessmentState: states.find((s2) => s2 !== 'clear') ?? states[0] ?? 'unassessed',
        ...(parsed.find((p) => p.meta?.coverageNotice)?.meta?.coverageNotice
          ? { coverageNotice: parsed.find((p) => p.meta?.coverageNotice)!.meta!.coverageNotice! }
          : {}),
        ...(parsed.find((p) => p.meta?.coverageStatement)?.meta?.coverageStatement
          ? { coverageStatement: parsed.find((p) => p.meta?.coverageStatement)!.meta!.coverageStatement! }
          : {}), // Ruling 197.2: about the medicine, so once for the answer, not once
        // per supplement queried.
        ...(() => {
          const notices = [...new Set(parsed.flatMap((p) => p.meta?.medicineNotices ?? []))];
          return notices.length ? { medicineNotices: notices } : {};
        })(),
      };
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
            // An empty list is only CLEAR when the server says the input was
            // assessed. Anything else is "we could not check", which must not
            // be printed in green.
            // ⚠️ ONLY 'clear'. This read `=== undefined || === 'clear'`, so the
            // absence of a state satisfied the green branch — the comment above
            // already said otherwise, which is the whole lesson: a comment does
            // not change what a consumer does.
            const clear = r.assessmentState === 'clear';
            // Naming the CAUSE only where we know it. 'unassessed' is the state
            // the server sets for an input it could not identify; the others
            // mean something was found and is not graded.
            const why =
              r.assessmentState === 'unassessed' ? dim('(medication not recognised)') : dim('(not graded)');
            // ⚠️ Pharmacist ruling 263 (7 October 2026): "clear" is a library
            // coverage statement, never safety. Her sentence, not green, and
            // never "no known interaction".
            out.push(
              clear
                ? `  ${d.supplement.name}  ${r.coverageStatement ?? NO_DOCUMENTED_INTERACTION}`
                : `  ${d.supplement.name}  ${yellow('not assessed')}  ${why}`,
            );
          } else {
            for (const di of d.drugInteractions) {
              // An ungraded row must never be printed as a severity word — the
              // colour alone would read as a graded verdict.
              const ungraded = di.reviewState === 'ungraded';
              // Ruling 254: a provisional or class-term grade is held, not
              // published, and says so rather than "not graded".
              // Ruling 262 (7 October 2026): an older payload that still sends a
              // provisional grade beside its marker is withheld here too.
              const held =
                (di.reviewState === 'ungraded' &&
                  (di.reviewStatus === 'provisional' || di.reviewStatus === 'class-term')) ||
                (di.reviewState !== 'ungraded' && di.gradeConfidence === 'provisional');
              const grade = held
                ? yellow('grade not validated')
                : ungraded || di.severity === null
                  ? yellow('not graded')
                  : drugSeverityColor(di.severity);
              // A row reached by CLASS says so: the reader asked about one drug
              // and is being shown a row written about the family it belongs to.
              // Say HOW, not just that it was widened — `example` and `class` reach a
              // row the reader did not name, and they reach it for different reasons.
              const via =
                di.matchedVia && di.matchedVia !== 'exact' ? ` ${dim(`(${di.matchedVia} match)`)}` : '';
              // Ruling 262: no "(provisional grade)" tag and no grade word: `held`
              // above prints "grade not validated" instead of the severity.
              const provisional = di.reviewState !== 'ungraded' && di.gradeConfidence === 'provisional';
              out.push(`  ${d.supplement.name}  ${grade}  ${dim(`(${di.medication})`)}${via}`);
              out.push(`    ${dim(di.description)}`);
              // Ruling 192.2: the server withheld the row's tablet advice because
              // the form is unknown. Print its question, never a silence.
              if (di.routeClarification) out.push(`    ${yellow(di.routeClarification)}`);
              if (ungraded && di.ungradedNote) out.push(`    ${yellow(di.ungradedNote)}`);
              if (di.reviewState !== 'ungraded' && provisional && di.provisionalNote) {
                out.push(`    ${yellow(di.provisionalNote)}`);
              }
            }
          }
        }
        // Ruling 197.3: an uncovered medication is named with the pharmacist
        // route, so "not assessed" is never the whole answer.
        if (r.coverageNotice) out.push('', yellow(r.coverageNotice));
        // Ruling 197.2: a notice about the medicine itself, printed once.
        for (const notice of r.medicineNotices ?? []) out.push('', yellow(notice));
        out.push(
          '',
          dim("Drug-interaction data from each supplement's safety profile — not medical advice."),
        );
        return out.join('\n');
      }
      if (r.mode === 'pathway') {
        const a = r.data.pathwayAnalysis;
        // Ruling 254: a provisional or unassessed pair has no score, type or
        // grade to print. Its status, precaution and note are what it says.
        if (a.reviewStatus === 'provisional' || a.reviewStatus === 'unassessed') {
          return [
            `${bold(`${r.data.supplement1} + ${r.data.supplement2}`)}  ${yellow(a.reviewStatus === 'provisional' ? 'grade not validated' : 'not assessed')}`,
            '',
            a.status ?? '',
            ...(a.guidance ? [a.guidance] : []),
            ...(a.pathwayInference ? ['', dim(a.pathwayInference)] : []),
            ...(a.note ? ['', dim(a.note)] : []),
          ].join('\n');
        }
        const out = [
          `${bold(`${r.data.supplement1} + ${r.data.supplement2}`)}  ${severityColor(a.type)}`,
          // An unsigned pair has no score or confidence to print — the route
          // stops sending them, and inventing a placeholder would be worse.
          a.reviewState === 'ungraded'
            ? `  ${yellow('not graded')}  ${dim('(under clinical review)')}`
            : a.provisionalGrade
              ? `  ${yellow('grade not validated')}  ${dim('(held for clinical review)')}`
              : dim(`score ${a.score}/100 · confidence ${a.confidence}/100`),
          '',
          a.reviewState === 'ungraded' ? (a.guidance ?? '') : (a.explanation ?? ''),
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
          out.push(
            i.severity === null || i.source === 'synergies'
              ? `  ${i.between.join(' + ')}  ${dim(i.type)}  ${yellow('not graded')}`
              : i.reviewState === 'ungraded'
                ? i.reviewStatus === 'provisional'
                  ? `  ${i.between.join(' + ')}  ${yellow('grade not validated')}  ${dim('(held for clinical review)')}`
                  : `  ${i.between.join(' + ')}  ${yellow('not graded')}  ${dim('(under clinical review)')}`
                : i.gradeConfidence === 'provisional'
                  ? `  ${i.between.join(' + ')}  ${severityColor(i.severity)}  ${yellow('grade not validated')}`
                  : `  ${i.between.join(' + ')}  ${severityColor(i.severity)}${i.tier ? ' · ' + drugSeverityColor(i.tier) : ''}`,
          );
          out.push(`    ${dim(i.description)}`);
          if (i.recommendation) out.push(`    ${dim(i.recommendation)}`);
          if (i.reviewStatus === 'provisional' && i.ungradedNote) out.push(`    ${yellow(i.ungradedNote)}`);
        }
      } else {
        // Ruling 254: an empty list is missing information, not "none".
        out.push(
          '',
          dim(
            'No documented interaction between these supplements in our library. Not assessed, and not an all-clear.',
          ),
        );
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
