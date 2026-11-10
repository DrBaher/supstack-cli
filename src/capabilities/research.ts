import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, dim, yellow } from '../output';

const Detail = z.object({
  name: z.string(),
  slug: z.string(),
  shortDescription: z.string().nullish(),
  evidence: z
    .object({
      score: z.number().optional(),
      level: z.string().optional(),
      totalStudies: z.number().optional(),
    })
    .optional(),
  /**
   * Ruling 541 (14 October 2026): an entry that endorses no dose publishes
   * `limitState: 'no-endorsed-dose'`, null minimum/maximum and her W541 in
   * `doseStatement`. Declared so the parse keeps them (it strips the rest).
   */
  dosage: z
    .object({
      // Item 1110 (10 November 2026): null where the pharmacist's ruling hides the legacy dose sentence (430 entries).
      recommended: z.string().nullable().optional(),
      limitState: z.string().optional(),
      doseStatement: z.string().nullable().optional(),
      /**
       * Item 834 (pharmacist follow-up, 10 November 2026): her W721, "A source-matched dose range is not available for this
       * product and use.", for a studied-only entry whose minimum/maximum the API publishes as null (ruling 721). Declared so the
       * parse keeps it (it strips the rest), and printed below so the absence of a number never reads as a broken panel.
       */
      rangeStatement: z.string().nullable().optional(),
      /** Item 1110 Q1: her separate caveat, verbatim (English), for the 95 entries whose sentence is hidden. */
      caveat: z.string().nullable().optional(),
      /** Item 1110 Q2: her sentence where no dose assessment can be made against the stored range. */
      assessmentStatement: z.string().nullable().optional(),
    })
    .optional(),
});

/**
 * ⚠️ Round 186. `z.object().parse()` STRIPS undeclared keys at runtime — this is
 * the "code that discards a payload" case, not the "type that under-describes
 * one" that round 94 correctly distinguished.
 *
 * This schema declared `overallRating`, `warnings` and `drugInteractions` only.
 * The `/safety` endpoint carries `populationSafety`, `contraindications` and the
 * pregnancy/lactation fields — and it carries them BECAUSE an earlier round
 * found that without them, "for 38 supplements the app itself BLOCKS or WARNS on
 * for pregnancy or nursing, the reply said nothing about either", concluding:
 * "an assistant answering from that payload has nothing to be careful with."
 *
 * That assistant reaches the endpoint through THIS schema, which stripped the
 * fix back out. Round 48's rule at a package boundary.
 *
 * `populationSafety` is deliberately `z.unknown()`: it is the app's baked row,
 * its verdict union has widened twice (rounds 158, 185), and pinning a literal
 * union in the client is what broke rounds 64, 74, 77, 113 and 137. The client's
 * job is to RELAY it, not to re-adjudicate it.
 */
const Safety = z.object({
  overallRating: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  /**
   * ⚠️ A DISCRIMINATED UNION, not a nullable field beside a flag.
   *
   * This first shipped as `severity: z.string()` and threw on the real
   * `/safety` payload — `supstack research` and the MCP research tool crashed
   * on all 39 supplements with an ungraded row. The nullable fix that followed
   * still let `{ reviewState: 'reviewed', severity: null }` PARSE, which the
   * 2026-09-04 recheck demonstrated with a runtime probe. Owner ruling
   * R-005-02 asks for the invalid state to be unrepresentable at every layer,
   * and zod's `discriminatedUnion` is that layer's version of it.
   */
  drugInteractions: z
    .array(
      z.discriminatedUnion('reviewState', [
        // `authored` is the graded arm the API sends today (nothing is signed,
        // so nothing is `reviewed`). Without it this threw on every supplement
        // with a graded interaction (1 October 2026 audit).
        z.object({
          reviewState: z.literal('authored'),
          severity: z.string(),
          medication: z.string(),
          /** Ruling 539: the exact label the description is taken from. Carried because zod strips unknown keys. */
          source: z.object({ label: z.string(), url: z.string() }).optional(),
          description: z.string().optional(),
          // Pharmacist ruling 152: carried so the marker is not stripped.
          gradeConfidence: z.literal('provisional').optional(),
          provisionalNote: z.string().optional(),
        }),
        z.object({
          reviewState: z.literal('reviewed'),
          severity: z.string(),
          medication: z.string(),
          /** Ruling 539: the exact label the description is taken from. Carried because zod strips unknown keys. */
          source: z.object({ label: z.string(), url: z.string() }).optional(),
          description: z.string().optional(),
          // Pharmacist ruling 152: carried so the marker is not stripped.
          gradeConfidence: z.literal('provisional').optional(),
          provisionalNote: z.string().optional(),
        }),
        z.object({
          reviewState: z.literal('ungraded'),
          severity: z.null(),
          medication: z.string(),
          /** Ruling 539: the exact label the description is taken from. Carried because zod strips unknown keys. */
          source: z.object({ label: z.string(), url: z.string() }).optional(),
          description: z.string().optional(),
          ungradedNote: z.string().optional(),
          /** Ruling 254: why no grade is published. */
          reviewStatus: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  /**
   * ⚠️ DEPRECATED legacy alias (pharmacist ruling 272, 7 October 2026). The
   * server now sends the neutral label in front of the text. Read `doseLimit`.
   */
  maxSafeDose: z.string().optional(),
  /**
   * Ruling 272: the neutral dose-limit fields. `label` says what the text is
   * ("Dose reported in cited studies", "Established upper intake limit", ...),
   * `value` is set only for an established or reference upper intake limit,
   * and `isModelEstimate` is always false here.
   */
  doseLimit: z
    .object({
      doseLimitText: z.string(),
      label: z.string(),
      labelKind: z.string(),
      limitState: z.string(),
      source: z.string(),
      value: z.number().nullable(),
      unit: z.string().nullable(),
      population: z.string().nullable(),
      form: z.string().nullable(),
      isModelEstimate: z.boolean(),
    })
    .optional(),
  contraindications: z.array(z.string()).optional(),
  // Ruling 469 O-021 (12 October 2026): the contraindication lines that are a
  // use or sourcing restriction, typed. Each line is also in contraindications.
  useRestrictions: z.array(z.object({ text: z.string(), type: z.string() })).optional(),
  sideEffects: z
    .array(
      z.object({
        effect: z.string(),
        frequency: z.string(),
        severity: z.string(),
        mitigation: z.string().nullable(),
      }),
    )
    .optional(),
  populationSafety: z.unknown().optional(),
  pregnancyCategory: z.string().nullable().optional(),
  pregnancyRecommendation: z.string().nullable().optional(),
  lactationCategory: z.string().nullable().optional(),
  specialPopulations: z.array(z.object({ population: z.string(), recommendation: z.string() })).optional(),
});

interface ResearchResult {
  detail: z.infer<typeof Detail>;
  safety?: z.infer<typeof Safety>;
  protocol?: { recommended?: string; timing?: string[] };
  synergies?: { name: string; type: string }[];
}

const InputSchema = z.object({
  slug: z.string().min(1),
  protocol: z.boolean().optional(),
  synergies: z.boolean().optional(),
});

export const research = defineCapability({
  name: 'research',
  description: 'Full evidence summary for one supplement (detail + safety; optional protocol & synergies)',
  inputSchema: InputSchema,
  cli: {
    command: 'research',
    args: '<slug>',
    options: [
      { flags: '--protocol', description: 'Include dosing protocol' },
      { flags: '--synergies', description: 'Include supplement synergies' },
    ],
  },
  mcp: {
    toolName: 'supstack_research',
    description:
      'Get a full evidence summary for a single supplement by slug: description, evidence score, recommended dosage, and safety profile — contraindications, warnings, drug interactions, and `populationSafety`, which carries per-population verdicts (pregnancy, nursing, under-18, 65+, per-condition). Gate on `populationSafety`: a verdict of `unknown` means NOT ASSESSED, which is not the same as no risk. Optionally include the dosing protocol and synergies. Use when the user wants a deep dive on one supplement.',
  },
  handler: async ({ slug, protocol, synergies }): Promise<ResearchResult> => {
    const encoded = encodeURIComponent(slug);
    const [detailRes, safetyRes] = await Promise.all([
      apiGet<{ data: unknown }>(`/supplements/${encoded}`),
      apiGet<{ data: { safety?: unknown } }>('/safety', { query: { supplement: slug } }).catch(
        () => undefined,
      ),
    ]);

    const result: ResearchResult = { detail: Detail.parse(detailRes.data) };
    if (safetyRes?.data?.safety) result.safety = Safety.parse(safetyRes.data.safety);

    if (protocol) {
      const p = await apiGet<{
        data: { dosage?: { recommended?: string | null }; timing?: { optimal?: string[] } };
      }>(`/supplements/${encoded}/protocol`).catch(() => undefined);
      if (p?.data)
        result.protocol = {
          recommended: p.data.dosage?.recommended ?? undefined,
          timing: p.data.timing?.optimal,
        };
    }

    if (synergies) {
      const s = await apiGet<{ data: { synergies?: { supplementName: string; synergyType: string }[] } }>(
        '/synergies',
        { query: { supplement: slug } },
      ).catch(() => undefined);
      if (s?.data?.synergies) {
        result.synergies = s.data.synergies.map((x) => ({ name: x.supplementName, type: x.synergyType }));
      }
    }

    return result;
  },
  format: {
    text: (r): string => {
      const out: string[] = [];
      const ev = r.detail.evidence;
      const evLine = ev
        ? dim(
            `evidence ${ev.score !== undefined ? `${ev.score}/10` : '?'}${ev.level ? ` (${ev.level})` : ''}${ev.totalStudies ? ` · ${ev.totalStudies} studies` : ''}`,
          )
        : '';
      out.push(`${bold(r.detail.name)} ${dim(r.detail.slug)}`);
      if (evLine) out.push(evLine);
      if (r.detail.shortDescription) out.push('', r.detail.shortDescription);
      // Ruling 541: the explicit no-endorsed-dose statement leads, never a number.
      const dose = r.detail.dosage;
      if (dose?.doseStatement) {
        out.push('', `${bold('Dose')}  ${dose.doseStatement}`);
        if (dose.recommended && dose.recommended !== dose.doseStatement) out.push(dose.recommended);
      } else if (dose?.recommended) {
        out.push('', `${bold('Dose')}  ${dose.recommended}`);
      }
      // Item 834: her W721 where the API withholds the studied range.
      if (dose?.rangeStatement) out.push(dose.rangeStatement);
      // Item 1110: her caveat and her Q2 sentence, verbatim, beside it.
      if (dose?.caveat) out.push(dose.caveat);
      if (dose?.assessmentStatement) out.push(dose.assessmentStatement);

      if (r.protocol) {
        const bits = [
          r.protocol.recommended,
          r.protocol.timing?.length ? `timing: ${r.protocol.timing.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('  ·  ');
        if (bits) out.push('', `${bold('Protocol')}  ${bits}`);
      }

      if (r.safety) {
        out.push('', `${bold('Safety')}  ${r.safety.overallRating ?? 'n/a'}`);
        // Ruling 272: the dose text with its own label, never "max safe".
        if (r.safety.doseLimit?.doseLimitText) {
          out.push(`  ${dim(`${r.safety.doseLimit.label}:`)} ${r.safety.doseLimit.doseLimitText}`);
        }
        // A contraindication is the strongest thing this payload carries — dhea's
        // "exogenous hormones may cause birth defects" lives here, not in
        // `warnings`. It printed nowhere before round 186.
        for (const c of r.safety.contraindications ?? []) out.push(`  ${yellow('⛔')} ${c}`);
        if (r.safety.pregnancyRecommendation) {
          out.push(`  ${yellow('⚠')} Pregnancy: ${r.safety.pregnancyRecommendation}`);
        }
        for (const w of r.safety.warnings ?? []) out.push(`  ${yellow('⚠')} ${w}`);
        const di = r.safety.drugInteractions ?? [];
        if (di.length) {
          out.push(dim(`  Drug interactions (${di.length}):`));
          /**
           * ⚠️ `${d.severity}` on an ungraded row printed the literal string
           * "null" — `Warfarin — null` — and dropped the disclosure entirely.
           * Reproduced by the 2026-09-04b recheck against the real generated
           * fixture; the composition tests added before it asserted parsing and
           * machine output only, and never called this formatter.
           */
          for (const d of di.slice(0, 5)) {
            if (d.reviewState === 'ungraded') {
              // Ruling 254: a provisional grade is held, not published.
              out.push(
                `    ${d.medication} — ${yellow(d.reviewStatus === 'provisional' || d.reviewStatus === 'class-term' ? 'grade not validated' : 'not graded')}`,
              );
              if (d.ungradedNote) out.push(dim(`      ${d.ungradedNote}`));
            } else if (d.gradeConfidence === 'provisional') {
              // Ruling 262 (7 October 2026): an older payload's provisional grade
              // is withheld here too, never printed.
              out.push(`    ${d.medication} — ${yellow('grade not validated')}`);
              if (d.provisionalNote) out.push(dim(`      ${d.provisionalNote}`));
            } else {
              out.push(`    ${d.medication} — ${d.severity}`);
            }
          }
          if (di.length > 5) out.push(dim(`    …and ${di.length - 5} more`));
        }
      }

      if (r.synergies?.length) {
        out.push('', `${bold('Synergies')}`);
        for (const s of r.synergies.slice(0, 8)) out.push(`  ${s.name} (${dim(s.type)})`);
      }

      return out.join('\n');
    },
    json: (r): unknown => r,
  },
});
