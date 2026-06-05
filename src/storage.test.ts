import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addToStack, normalizeSlug, readStack, removeFromStack } from './storage';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-test-'));
  process.env.SUPSTACK_HOME = home;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('local stack storage', () => {
  it('starts empty', () => {
    expect(readStack()).toEqual([]);
  });

  it('adds idempotently and persists', () => {
    addToStack('magnesium');
    addToStack('magnesium');
    addToStack('glycine');
    expect(readStack()).toEqual(['magnesium', 'glycine']);
  });

  it('removes a slug', () => {
    addToStack('magnesium');
    addToStack('glycine');
    expect(removeFromStack('magnesium')).toEqual(['glycine']);
    expect(readStack()).toEqual(['glycine']);
  });

  it('normalizes slugs on add so they match the API (lowercase, trimmed)', () => {
    addToStack('  Magnesium ');
    addToStack('L-Theanine');
    expect(readStack()).toEqual(['magnesium', 'l-theanine']);
  });

  it('treats case variants as the same supplement (add + remove)', () => {
    addToStack('magnesium');
    addToStack('MAGNESIUM'); // same supplement → no duplicate
    expect(readStack()).toEqual(['magnesium']);
    expect(removeFromStack('Magnesium')).toEqual([]); // mixed-case remove still matches
  });
});

describe('normalizeSlug', () => {
  it('lowercases and trims', () => {
    expect(normalizeSlug('  Vitamin-D3 ')).toBe('vitamin-d3');
    expect(normalizeSlug('magnesium')).toBe('magnesium');
  });
});
