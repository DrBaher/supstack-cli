import { readFileSync, writeFileSync } from 'node:fs';

import { ensureDir, homePath, supstackHome } from './paths';

const STACK_FILE = 'stack.json';

interface StoredStack {
  supplements: string[];
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

/** Read the local stack (list of supplement slugs). Returns [] if none. */
export function readStack(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(homePath(STACK_FILE), 'utf8')) as StoredStack;
    return Array.isArray(parsed.supplements) ? parsed.supplements : [];
  } catch {
    return [];
  }
}

function writeStack(slugs: string[]): void {
  ensureDir(supstackHome());
  const unique = [...new Set(slugs)];
  writeFileSync(homePath(STACK_FILE), JSON.stringify({ supplements: unique }, null, 2) + '\n');
}

/** Add a slug (idempotent, normalized). Returns the resulting stack. */
export function addToStack(slug: string): string[] {
  const normalized = normalizeSlug(slug);
  const stack = readStack();
  if (!stack.includes(normalized)) stack.push(normalized);
  writeStack(stack);
  return stack;
}

/** Remove a slug (matched after normalization). Returns the resulting stack. */
export function removeFromStack(slug: string): string[] {
  const normalized = normalizeSlug(slug);
  const next = readStack().filter((s) => s !== normalized);
  writeStack(next);
  return next;
}
