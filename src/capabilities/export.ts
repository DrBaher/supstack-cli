import { z } from 'zod';

import { defineCapability } from '../capability';
import { DISCLAIMER } from '../constants';
import { apiGet } from '../http';
import { dim } from '../output';
import { readStack } from '../storage';

const Detail = z.object({
  name: z.string(),
  slug: z.string(),
  shortDescription: z.string().nullish(),
  evidence: z.object({ score: z.number().optional(), level: z.string().optional() }).optional(),
  dosage: z.object({ recommended: z.string().optional() }).optional(),
  safety: z.object({ overallRating: z.string().optional() }).optional(),
});

interface ExportItem {
  slug: string;
  name: string;
  description?: string;
  evidenceScore?: number;
  dose?: string;
  safety?: string;
}

interface ExportResult {
  format: 'md' | 'json';
  items: ExportItem[];
  requested: number;
}

const InputSchema = z.object({
  format: z.enum(['md', 'json']).default('md'),
});

async function fetchItem(slug: string): Promise<ExportItem | null> {
  try {
    const res = await apiGet<{ data: unknown }>(`/supplements/${encodeURIComponent(slug)}`);
    const d = Detail.parse(res.data);
    return {
      slug: d.slug,
      name: d.name,
      description: d.shortDescription ?? undefined,
      evidenceScore: d.evidence?.score,
      dose: d.dosage?.recommended,
      safety: d.safety?.overallRating,
    };
  } catch {
    return null;
  }
}

function toMarkdown(items: ExportItem[]): string {
  if (items.length === 0) return '# My SupStack Stack\n\n_Your stack is empty._\n';
  const lines = ['# My SupStack Stack', ''];
  for (const it of items) {
    lines.push(`## ${it.name}`);
    if (it.description) lines.push('', it.description);
    const facts: string[] = [];
    if (it.dose) facts.push(`- **Dose:** ${it.dose}`);
    if (it.evidenceScore !== undefined) facts.push(`- **Evidence:** ${it.evidenceScore}/10`);
    if (it.safety) facts.push(`- **Safety:** ${it.safety}`);
    if (facts.length) lines.push('', ...facts);
    lines.push('');
  }
  lines.push(`_${items.length} supplement${items.length === 1 ? '' : 's'} · exported from SupStack._`);
  lines.push('', '---', `> ${DISCLAIMER}`);
  return lines.join('\n');
}

export const exportStack = defineCapability({
  name: 'export',
  description: 'Export your local stack as Markdown or JSON',
  inputSchema: InputSchema,
  cli: {
    command: 'export',
    options: [{ flags: '-f, --format <format>', description: 'Output format: md | json (default md)' }],
  },
  mcp: {
    toolName: 'supstack_export',
    description:
      "Export the user's locally-saved supplement stack, with each supplement's details fetched from SupStack (description, dose, evidence score, safety). format=md returns a Markdown document; format=json returns structured items.",
  },
  handler: async (input): Promise<ExportResult> => {
    const slugs = readStack();
    const fetched = await Promise.all(slugs.map(fetchItem));
    return {
      format: input.format,
      items: fetched.filter((x): x is ExportItem => x !== null),
      requested: slugs.length,
    };
  },
  format: {
    // The export artifact itself. `--format json` emits a JSON document;
    // `--format md` (default) emits Markdown. (`--json` global flag uses format.json below.)
    text: (r): string => {
      const dropped = r.requested - r.items.length;
      if (r.format === 'json') {
        const body = JSON.stringify(r.items, null, 2);
        return dropped > 0 ? `${body}\n${dim(`// ${dropped} slug(s) could not be fetched`)}` : body;
      }
      const md = toMarkdown(r.items);
      return dropped > 0 ? `${md}\n${dim(`<!-- ${dropped} slug(s) could not be fetched -->`)}` : md;
    },
    json: (r): unknown => r.items,
  },
});
