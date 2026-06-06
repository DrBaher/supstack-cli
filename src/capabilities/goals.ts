import { z } from 'zod';

import { defineCapability } from '../capability';
import { apiGet } from '../http';
import { bold, dim } from '../output';

const GoalSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string().optional(),
});
const GoalsResponse = z.object({ data: z.array(GoalSchema) });
type Goal = z.infer<typeof GoalSchema>;

const InputSchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
});

export const goals = defineCapability({
  name: 'goals',
  description: 'List health goal ids (use them with `rate` and `recommend`)',
  inputSchema: InputSchema,
  cli: {
    command: 'goals',
    args: '[query]',
    options: [
      { flags: '-c, --category <category>', description: 'Filter by category id (e.g. sleep, mental)' },
    ],
  },
  mcp: {
    toolName: 'supstack_goals',
    description:
      'List SupStack health goals — their ids, names, and categories. Use the returned `id` values as the `goals` argument to `supstack_rate_stack` and `supstack_recommend` (those tools need goal ids, not free text). Call this first to map a user\'s plain-language goal ("sleep better", "build muscle") to the correct id. Optionally filter with a free-text `query` (matches id or name) or a `category` id.',
  },
  handler: async (input): Promise<Goal[]> => {
    const res = await apiGet<unknown>('/goals');
    let list = GoalsResponse.parse(res).data;
    if (input.category) {
      const c = input.category.trim().toLowerCase();
      list = list.filter((g) => g.category.toLowerCase() === c);
    }
    if (input.query) {
      const q = input.query.trim().toLowerCase();
      list = list.filter((g) => g.id.includes(q) || g.name.toLowerCase().includes(q));
    }
    return list;
  },
  format: {
    text: (list): string => {
      if (list.length === 0) return dim('No goals found.');
      // Group by category, preserving first-seen order.
      const byCat = new Map<string, Goal[]>();
      for (const g of list) {
        const arr = byCat.get(g.category) ?? [];
        arr.push(g);
        byCat.set(g.category, arr);
      }
      const blocks: string[] = [];
      for (const [category, items] of byCat) {
        const rows = items.map((g) => `  ${g.id.padEnd(24)} ${dim(g.name)}`).join('\n');
        blocks.push(`${bold(category)}\n${rows}`);
      }
      return blocks.join('\n\n');
    },
    json: (list): unknown => list,
  },
});
