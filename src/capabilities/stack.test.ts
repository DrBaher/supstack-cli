import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addToStack, readStack } from '../storage';
import { stack } from './stack';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function cloudResponse(slugs: string[]): unknown {
  return {
    data: {
      stackId: 's1',
      name: 'My Stack',
      supplements: slugs.map((slug, i) => ({
        slug,
        dosage: null,
        timing: null,
        notes: null,
        brandName: null,
        position: i,
      })),
    },
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-stacksync-'));
  process.env.SUPSTACK_HOME = home;
  process.env.SUPSTACK_TOKEN = 'sct_live_x';
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('stack sync (capability)', () => {
  it('sync unions membership AND preserves existing cloud metadata', async () => {
    addToStack('magnesium');
    addToStack('glycine'); // local: [magnesium, glycine]
    // Cloud has glycine WITH metadata (must be preserved) + l-theanine.
    const cloudGet = {
      data: {
        stackId: 's1',
        name: 'My Stack',
        supplements: [
          { slug: 'glycine', dosage: '3g', timing: 'Evening', notes: null, brandName: 'Acme', position: 0 },
          { slug: 'l-theanine', dosage: null, timing: null, notes: null, brandName: null, position: 1 },
        ],
      },
    };
    let pushedItems: { slug: string; dosage?: string | null }[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          pushedItems = JSON.parse(String(init.body)).supplements;
          return jsonRes(cloudResponse(pushedItems.map((i) => i.slug)));
        }
        return jsonRes(cloudGet); // GET
      }),
    );

    const res = await stack.handler({ action: 'sync' });
    const union = new Set(['magnesium', 'glycine', 'l-theanine']);
    expect(new Set(res.stack)).toEqual(union); // returned
    expect(new Set(pushedItems.map((i) => i.slug))).toEqual(union); // membership unioned
    expect(new Set(readStack())).toEqual(union); // mirrored locally
    // glycine's existing dosage survived (not flattened to a bare slug).
    expect(pushedItems.find((i) => i.slug === 'glycine')?.dosage).toBe('3g');
  });

  it('list works offline (no token required)', async () => {
    delete process.env.SUPSTACK_TOKEN;
    addToStack('magnesium');
    const res = await stack.handler({ action: 'list' });
    expect(res.stack).toEqual(['magnesium']);
  });
});
