import { readFileSync, writeFileSync } from 'node:fs';

import { ensureDir, homePath, supstackHome } from './paths';

const STACK_FILE = 'stack.json';

interface StoredStack {
  supplements: string[];
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

/** Add a slug (idempotent). Returns the resulting stack. */
export function addToStack(slug: string): string[] {
  const stack = readStack();
  if (!stack.includes(slug)) stack.push(slug);
  writeStack(stack);
  return stack;
}

/** Remove a slug. Returns the resulting stack. */
export function removeFromStack(slug: string): string[] {
  const next = readStack().filter((s) => s !== slug);
  writeStack(next);
  return next;
}
