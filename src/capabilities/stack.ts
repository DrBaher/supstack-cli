import { z } from 'zod';

import { defineCapability } from '../capability';
import { bold, dim } from '../output';
import { addToStack, normalizeSlug, readStack, removeFromStack } from '../storage';

interface StackResult {
  action: 'add' | 'remove' | 'list';
  slug?: string;
  stack: string[];
}

const InputSchema = z
  .object({
    action: z.enum(['add', 'remove', 'list']),
    slug: z.string().optional(),
  })
  .refine((v) => v.action === 'list' || Boolean(v.slug), {
    message: 'add/remove require a supplement slug, e.g. `supstack stack add magnesium`',
    path: ['slug'],
  });

export const stack = defineCapability({
  name: 'stack',
  description: 'Manage your local supplement stack (add | remove | list)',
  inputSchema: InputSchema,
  cli: { command: 'stack', args: '<action> [slug]' },
  mcp: {
    toolName: 'supstack_stack',
    description:
      'Manage the user\'s local supplement stack stored on this machine. action="list" returns the current stack; action="add" with a slug adds a supplement; action="remove" with a slug removes one. Slugs are SupStack supplement ids (e.g. magnesium).',
    mutates: true,
  },
  handler: async (input): Promise<StackResult> => {
    switch (input.action) {
      case 'add':
        return {
          action: 'add',
          slug: normalizeSlug(input.slug as string),
          stack: addToStack(input.slug as string),
        };
      case 'remove':
        return {
          action: 'remove',
          slug: normalizeSlug(input.slug as string),
          stack: removeFromStack(input.slug as string),
        };
      case 'list':
        return { action: 'list', stack: readStack() };
    }
  },
  format: {
    text: (r): string => {
      const header =
        r.action === 'add' ? dim(`Added ${r.slug}.`) : r.action === 'remove' ? dim(`Removed ${r.slug}.`) : '';
      const list =
        r.stack.length === 0
          ? dim('Your stack is empty.')
          : `${bold(`Your stack (${r.stack.length})`)}\n` + r.stack.map((s) => `  • ${s}`).join('\n');
      return header ? `${header}\n${list}` : list;
    },
    json: (r): unknown => r,
  },
});
