import { z } from 'zod';

import { defineCapability } from '../capability';
import { type CloudStackItem, getCloudStack, putCloudStack, type StackPutItem } from '../cloud-stack';
import { bold, dim } from '../output';
import {
  addToStack,
  normalizeSlug,
  readStackItems,
  removeFromStack,
  setStack,
  type StackItem,
} from '../storage';

type StackAction = 'add' | 'remove' | 'list' | 'pull' | 'push' | 'sync';

interface StackResult {
  action: StackAction;
  slug?: string;
  stack: StackItem[];
  /** Set for cloud actions — what happened, for the human summary. */
  cloud?: 'pulled' | 'pushed' | 'synced';
}

const InputSchema = z
  .object({
    action: z.enum(['add', 'remove', 'list', 'pull', 'push', 'sync']),
    slug: z.string().optional(),
    dose: z.string().optional(),
    timing: z.string().optional(),
    brand: z.string().optional(),
  })
  .refine((v) => (v.action !== 'add' && v.action !== 'remove' ? true : Boolean(v.slug)), {
    message: 'add/remove require a supplement slug, e.g. `supstack stack add magnesium`',
    path: ['slug'],
  });

/** Cloud item → local StackItem (brandName → brand, nulls dropped). */
function fromCloud(s: CloudStackItem): StackItem {
  const item: StackItem = { slug: s.slug };
  if (s.dosage) item.dosage = s.dosage;
  if (s.timing) item.timing = s.timing;
  if (s.brandName) item.brand = s.brandName;
  return item;
}

/** Local item (+ optional cloud fallback) → cloud put item. Local metadata wins. */
function toCloud(
  local: StackItem | undefined,
  cloud: CloudStackItem | undefined,
  slug: string,
): StackPutItem {
  return {
    slug,
    dosage: local?.dosage ?? cloud?.dosage ?? null,
    timing: local?.timing ?? cloud?.timing ?? null,
    notes: cloud?.notes ?? null,
    brandName: local?.brand ?? cloud?.brandName ?? null,
  };
}

export const stack = defineCapability({
  name: 'stack',
  description: 'Manage your stack — local (add | remove | list) or cloud (pull | push | sync)',
  inputSchema: InputSchema,
  cli: {
    command: 'stack',
    args: '<action> [slug]',
    options: [
      { flags: '--dose <dose>', description: 'Dosage for `add` (e.g. 400mg)' },
      { flags: '--timing <timing>', description: 'Timing for `add` (e.g. bedtime)' },
      { flags: '--brand <brand>', description: 'Brand for `add`' },
    ],
  },
  mcp: {
    toolName: 'supstack_stack',
    description:
      'Manage the user\'s supplement stack. Local: action="list" returns the local stack (slugs + any dosage/timing/brand); "add"/"remove" with a slug edit it — `add` also accepts dose, timing, and brand. Cloud (requires the user to be logged in): "pull" overwrites the local stack from their account, "push" overwrites their account from local, "sync" merges both (union) and saves to both — all preserving per-supplement dosage/timing/brand. Slugs are SupStack supplement ids (e.g. magnesium).',
    mutates: true,
  },
  handler: async (input): Promise<StackResult> => {
    const meta = { dosage: input.dose, timing: input.timing, brand: input.brand };
    switch (input.action) {
      case 'add':
        return {
          action: 'add',
          slug: normalizeSlug(input.slug as string),
          stack: addToStack(input.slug as string, meta),
        };
      case 'remove':
        return {
          action: 'remove',
          slug: normalizeSlug(input.slug as string),
          stack: removeFromStack(input.slug as string),
        };
      case 'list':
        return { action: 'list', stack: readStackItems() };

      case 'pull': {
        // Cloud → local, preserving the cloud's dosage/timing/brand.
        const cloud = await getCloudStack();
        return { action: 'pull', cloud: 'pulled', stack: setStack(cloud.supplements.map(fromCloud)) };
      }
      case 'push': {
        // Membership = local. Local metadata wins; fall back to existing cloud
        // metadata for slugs that stay; drop cloud slugs not in local.
        const local = readStackItems();
        const cloud = await getCloudStack();
        const cloudBySlug = new Map(cloud.supplements.map((s) => [s.slug, s]));
        const items = local.map((l) => toCloud(l, cloudBySlug.get(l.slug), l.slug));
        const saved = await putCloudStack(items);
        return { action: 'push', cloud: 'pushed', stack: saved.supplements.map(fromCloud) };
      }
      case 'sync': {
        // Additive union of slugs, merging metadata (local wins). Mirror to both.
        const local = readStackItems();
        const cloud = await getCloudStack();
        const localBySlug = new Map(local.map((i) => [i.slug, i]));
        const cloudBySlug = new Map(cloud.supplements.map((s) => [s.slug, s]));
        const slugs = [...new Set([...cloud.supplements.map((s) => s.slug), ...local.map((i) => i.slug)])];
        const merged = slugs.map((slug) => toCloud(localBySlug.get(slug), cloudBySlug.get(slug), slug));
        const saved = await putCloudStack(merged);
        const items = saved.supplements.map(fromCloud);
        setStack(items);
        return { action: 'sync', cloud: 'synced', stack: items };
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

      const renderItem = (i: StackItem): string => {
        const m = [i.dosage, i.timing, i.brand].filter(Boolean).join(' · ');
        return `  • ${i.slug}${m ? `  ${dim(m)}` : ''}`;
      };
      const list =
        r.stack.length === 0
          ? dim('Your stack is empty.')
          : `${bold(`Your stack (${r.stack.length})`)}\n` + r.stack.map(renderItem).join('\n');
      return header ? `${header}\n${list}` : list;
    },
    json: (r): unknown => r,
  },
});
