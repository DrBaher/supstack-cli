import { z } from 'zod';

import { defineCapability } from '../capability';
import { getCloudStack, putCloudStack } from '../cloud-stack';
import { bold, dim } from '../output';
import { addToStack, normalizeSlug, readStack, removeFromStack, setStack } from '../storage';

type StackAction = 'add' | 'remove' | 'list' | 'pull' | 'push' | 'sync';

interface StackResult {
  action: StackAction;
  slug?: string;
  stack: string[];
  /** Set for cloud actions — what happened, for the human summary. */
  cloud?: 'pulled' | 'pushed' | 'synced';
}

const InputSchema = z
  .object({
    action: z.enum(['add', 'remove', 'list', 'pull', 'push', 'sync']),
    slug: z.string().optional(),
  })
  .refine((v) => (v.action !== 'add' && v.action !== 'remove' ? true : Boolean(v.slug)), {
    message: 'add/remove require a supplement slug, e.g. `supstack stack add magnesium`',
    path: ['slug'],
  });

export const stack = defineCapability({
  name: 'stack',
  description: 'Manage your stack — local (add | remove | list) or cloud (pull | push | sync)',
  inputSchema: InputSchema,
  cli: { command: 'stack', args: '<action> [slug]' },
  mcp: {
    toolName: 'supstack_stack',
    description:
      'Manage the user\'s supplement stack. Local: action="list" returns the local stack; "add"/"remove" with a slug edit it. Cloud (requires the user to be logged in): "pull" overwrites the local stack from their account, "push" overwrites their account from local, "sync" merges both (union) and saves to both. Slugs are SupStack supplement ids (e.g. magnesium).',
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

      case 'pull': {
        // Cloud → local (local is slug-only by design; metadata stays in the cloud).
        const cloud = await getCloudStack();
        return { action: 'pull', cloud: 'pulled', stack: setStack(cloud.supplements.map((s) => s.slug)) };
      }
      case 'push': {
        // Membership = local. Preserve cloud metadata for slugs that stay; add
        // local-only slugs as bare; drop cloud slugs not in local.
        const local = readStack();
        const cloud = await getCloudStack();
        const bySlug = new Map(cloud.supplements.map((s) => [s.slug, s]));
        const items = local.map((slug) => bySlug.get(slug) ?? { slug });
        const saved = await putCloudStack(items);
        return { action: 'push', cloud: 'pushed', stack: saved.supplements.map((s) => s.slug) };
      }
      case 'sync': {
        // Additive union: keep every existing cloud item WITH its metadata, add
        // local-only slugs as bare. Never drops or flattens. Mirror union to local.
        const local = readStack();
        const cloud = await getCloudStack();
        const cloudSlugs = new Set(cloud.supplements.map((s) => s.slug));
        const newOnes = local.filter((slug) => !cloudSlugs.has(slug)).map((slug) => ({ slug }));
        const saved = await putCloudStack([...cloud.supplements, ...newOnes]);
        const slugs = saved.supplements.map((s) => s.slug);
        setStack(slugs);
        return { action: 'sync', cloud: 'synced', stack: slugs };
      }
    }
  },
  format: {
    text: (r): string => {
      let header = '';
      if (r.action === 'add') header = dim(`Added ${r.slug}.`);
      else if (r.action === 'remove') header = dim(`Removed ${r.slug}.`);
      else if (r.cloud === 'pulled') header = dim(`Pulled your stack from your account.`);
      else if (r.cloud === 'pushed') header = dim(`Pushed your stack to your account.`);
      else if (r.cloud === 'synced') header = dim(`Synced your stack with your account.`);

      const list =
        r.stack.length === 0
          ? dim('Your stack is empty.')
          : `${bold(`Your stack (${r.stack.length})`)}\n` + r.stack.map((s) => `  • ${s}`).join('\n');
      return header ? `${header}\n${list}` : list;
    },
    json: (r): unknown => r,
  },
});
