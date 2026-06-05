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
  dosage: z.object({ recommended: z.string().optional() }).optional(),
});

const Safety = z.object({
  overallRating: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  drugInteractions: z.array(z.object({ medication: z.string(), severity: z.string() })).optional(),
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
      'Get a full evidence summary for a single supplement by slug: description, evidence score, recommended dosage, and safety profile (warnings + drug interactions). Optionally include the dosing protocol and synergies. Use when the user wants a deep dive on one supplement.',
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
        data: { dosage?: { recommended?: string }; timing?: { optimal?: string[] } };
      }>(`/supplements/${encoded}/protocol`).catch(() => undefined);
      if (p?.data)
        result.protocol = { recommended: p.data.dosage?.recommended, timing: p.data.timing?.optimal };
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
            `evidence ${ev.score ?? '?'}${ev.level ? ` (${ev.level})` : ''}${ev.totalStudies ? ` · ${ev.totalStudies} studies` : ''}`,
          )
        : '';
      out.push(`${bold(r.detail.name)} ${dim(r.detail.slug)}`);
      if (evLine) out.push(evLine);
      if (r.detail.shortDescription) out.push('', r.detail.shortDescription);
      if (r.detail.dosage?.recommended) out.push('', `${bold('Dose')}  ${r.detail.dosage.recommended}`);

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
        for (const w of r.safety.warnings ?? []) out.push(`  ${yellow('⚠')} ${w}`);
        const di = r.safety.drugInteractions ?? [];
        if (di.length) {
          out.push(dim(`  Drug interactions (${di.length}):`));
          for (const d of di.slice(0, 5)) out.push(`    ${d.medication} — ${d.severity}`);
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
