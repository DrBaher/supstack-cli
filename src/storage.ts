import { readFileSync, writeFileSync } from 'node:fs';

import { ensureDir, homePath, supstackHome } from './paths';

const STACK_FILE = 'stack.json';

/** A local stack entry — a slug plus optional per-supplement metadata. */
export interface StackItem {
  slug: string;
  dosage?: string;
  timing?: string;
  brand?: string;
}

/** Optional metadata accepted when adding/updating an item. */
export type StackMeta = Partial<Omit<StackItem, 'slug'>>;

interface StoredStack {
  // Legacy files store `string[]`; current files store `StackItem[]`. Both read.
  supplements: Array<string | Partial<StackItem>>;
}

/**
 * Normalize a slug to the form the API accepts. SupStack slugs are
 * lowercase-kebab; the API 400s on any other case (e.g. `Magnesium`). Without
 * this, `stack add Magnesium` would store an unusable slug that `export` then
 * silently drops. Also dedupes case variants (`Magnesium` ≡ `magnesium`).
 */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/** Coerce a stored entry (legacy string OR object) into a clean StackItem. */
function normalizeItem(raw: string | Partial<StackItem>): StackItem | null {
  const slug = normalizeSlug(typeof raw === 'string' ? raw : (raw?.slug ?? ''));
  if (!slug) return null;
  const item: StackItem = { slug };
  if (typeof raw === 'object') {
    if (raw.dosage) item.dosage = String(raw.dosage);
    if (raw.timing) item.timing = String(raw.timing);
    if (raw.brand) item.brand = String(raw.brand);
  }
  return item;
}

/** Read the local stack as full items (with metadata). Returns [] if none. */
export function readStackItems(): StackItem[] {
  try {
    const parsed = JSON.parse(readFileSync(homePath(STACK_FILE), 'utf8')) as StoredStack;
    const arr = Array.isArray(parsed.supplements) ? parsed.supplements : [];
    const items: StackItem[] = [];
    const seen = new Set<string>();
    for (const raw of arr) {
      const item = normalizeItem(raw);
      if (item && !seen.has(item.slug)) {
        seen.add(item.slug);
        items.push(item);
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** Read the local stack as slugs (back-compat for slug-only consumers). */
export function readStack(): string[] {
  return readStackItems().map((i) => i.slug);
}

function writeStackItems(items: StackItem[]): void {
  ensureDir(supstackHome());
  const seen = new Set<string>();
  const unique = items.filter((i) => i.slug && !seen.has(i.slug) && (seen.add(i.slug), true));
  writeFileSync(homePath(STACK_FILE), JSON.stringify({ supplements: unique }, null, 2) + '\n');
}

/** Replace the entire local stack (normalized + deduped). Used by cloud pull/sync. */
export function setStack(items: Array<string | Partial<StackItem>>): StackItem[] {
  const normalized: StackItem[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const item = normalizeItem(raw);
    if (item && !seen.has(item.slug)) {
      seen.add(item.slug);
      normalized.push(item);
    }
  }
  writeStackItems(normalized);
  return normalized;
}

/**
 * Add a slug (idempotent, normalized), optionally with metadata. If the item
 * already exists, any provided metadata fields are merged in (others untouched).
 */
export function addToStack(slug: string, meta?: StackMeta): StackItem[] {
  const normalized = normalizeSlug(slug);
  if (!normalized) return readStackItems();
  const items = readStackItems();
  const existing = items.find((i) => i.slug === normalized);
  if (existing) {
    if (meta?.dosage) existing.dosage = meta.dosage;
    if (meta?.timing) existing.timing = meta.timing;
    if (meta?.brand) existing.brand = meta.brand;
  } else {
    items.push({ slug: normalized, ...stripEmpty(meta) });
  }
  writeStackItems(items);
  return items;
}

function stripEmpty(meta?: StackMeta): StackMeta {
  const out: StackMeta = {};
  if (meta?.dosage) out.dosage = meta.dosage;
  if (meta?.timing) out.timing = meta.timing;
  if (meta?.brand) out.brand = meta.brand;
  return out;
}

/** Remove a slug (matched after normalization). Returns the resulting stack. */
export function removeFromStack(slug: string): StackItem[] {
  const normalized = normalizeSlug(slug);
  const next = readStackItems().filter((i) => i.slug !== normalized);
  writeStackItems(next);
  return next;
}
