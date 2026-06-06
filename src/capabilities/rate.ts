import { z } from 'zod';

import { defineCapability } from '../capability';
import { getCloudStack } from '../cloud-stack';
import { getToken } from '../config';
import { apiGet } from '../http';
import { bold, cyan, dim, green, yellow } from '../output';
import { getProfile } from '../profile';
import { readStack } from '../storage';

const GradeResponse = z.object({
  data: z.object({
    letter: z.enum(['A', 'B', 'C', 'D', 'F']),
    score: z.number(),
    verdict: z.string(),
    goalsSource: z.enum(['provided', 'inferred']),
    goals: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        coveredBy: z.string().nullable(),
        coverage: z.number(),
        label: z.enum(['strong', 'good', 'moderate', 'weak', 'none']),
      }),
    ),
    gaps: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    stack: z.array(z.string()),
    unknownSupplements: z.array(z.string()).default([]),
    unknownGoals: z.array(z.string()).default([]),
  }),
});

type GradeData = z.infer<typeof GradeResponse>['data'];

/** Accept either a comma string (CLI `--goals a,b`) or an array (MCP). */
const csvOrArray = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

const InputSchema = z.object({
  supplements: z.array(z.string().min(1)).optional(),
  goals: csvOrArray.optional(),
  cloud: z.boolean().optional(),
});

export const rate = defineCapability({
  name: 'rate',
  description: 'Rate your stack (A–F) by how well it covers your goals',
  inputSchema: InputSchema,
  cli: {
    command: 'rate',
    args: '[supplements...]',
    options: [
      {
        flags: '-g, --goals <list>',
        description: 'Comma-separated goal ids (else your account goals, else inferred from the stack)',
      },
      {
        flags: '--cloud',
        description: 'Rate your synced cloud stack instead of the local one (requires login)',
      },
    ],
  },
  mcp: {
    toolName: 'supstack_rate_stack',
    description:
      "Grade a supplement stack A–F (and 0–100) by how well it covers a set of goals, with a per-goal coverage breakdown and the gaps. Pass `supplements` (slugs) to grade a specific list; omit to grade the user's saved local stack. Pass `goals` (goal ids) to grade against them; omit to use the user's account goals when signed in, otherwise the goals are inferred from the stack.",
  },
  handler: async (input): Promise<GradeData> => {
    // Supplements: explicit list → cloud stack → local stack.
    let slugs = input.supplements && input.supplements.length ? input.supplements : undefined;
    if (!slugs) {
      slugs = input.cloud ? (await getCloudStack()).supplements.map((s) => s.slug) : readStack();
    }
    if (!slugs.length) {
      throw new Error(
        'Your stack is empty — add supplements (`supstack stack add <slug>`) or pass them: `supstack rate magnesium l-theanine`.',
      );
    }

    // Goals: explicit → account goals (when signed in) → none (server infers).
    let goals = input.goals && input.goals.length ? input.goals : undefined;
    if (!goals && getToken()) {
      try {
        const profile = await getProfile();
        if (profile?.primaryGoals?.length) goals = profile.primaryGoals;
      } catch {
        // Not reachable / no profile — let the server infer from the stack.
      }
    }

    const res = await apiGet<unknown>('/stack/grade', {
      query: {
        supplements: slugs.join(','),
        goals: goals?.length ? goals.join(',') : undefined,
      },
    });
    return GradeResponse.parse(res).data;
  },
  format: {
    text: (d): string => renderGrade(d),
    json: (d): unknown => d,
  },
});

function letterColor(letter: GradeData['letter']): string {
  if (letter === 'A' || letter === 'B') return bold(green(letter));
  if (letter === 'C') return bold(cyan(letter));
  return bold(yellow(letter)); // D, F
}

function labelColor(label: string): string {
  if (label === 'strong') return green(label);
  if (label === 'good') return cyan(label);
  if (label === 'none') return dim(label);
  return yellow(label); // moderate, weak
}

/** A 10-cell coverage bar from a 0–100 coverage score. */
function bar(coverage: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(coverage / 10)));
  return '█'.repeat(filled) + dim('░'.repeat(10 - filled));
}

function renderGrade(d: GradeData): string {
  const out: string[] = [];
  out.push(`${bold('Stack grade:')} ${letterColor(d.letter)}  ${dim(`(${d.score}/100)`)}`);
  out.push(d.verdict);
  out.push(
    dim(
      d.goalsSource === 'provided'
        ? `Graded against ${d.goals.length} goal${d.goals.length === 1 ? '' : 's'}.`
        : 'Goals inferred from your stack — pass --goals to choose your own.',
    ),
  );
  out.push('');
  for (const g of d.goals) {
    const covered = g.coveredBy ? dim(g.coveredBy) : dim('—');
    out.push(`  ${g.name.padEnd(28)} ${bar(g.coverage)} ${labelColor(g.label).padEnd(8)} ${covered}`);
  }
  if (d.gaps.length) {
    out.push('');
    out.push(dim(`Gaps: ${d.gaps.map((g) => g.name).join(', ')} — nothing in your stack covers that well.`));
  }
  if (d.unknownSupplements.length) {
    out.push(dim(`Skipped unknown: ${d.unknownSupplements.join(', ')}`));
  }
  return out.join('\n');
}
