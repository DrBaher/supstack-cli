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
    expect(new Set(res.stack.map((i) => i.slug))).toEqual(union); // returned
    expect(new Set(pushedItems.map((i) => i.slug))).toEqual(union); // membership unioned
    expect(new Set(readStack())).toEqual(union); // mirrored locally
    // glycine's existing dosage survived (not flattened to a bare slug).
    expect(pushedItems.find((i) => i.slug === 'glycine')?.dosage).toBe('3g');
  });

  it('push makes cloud membership match local, keeping metadata for kept slugs', async () => {
    addToStack('magnesium'); // local-only (new)
    addToStack('glycine'); // also in cloud (with metadata)
    // Cloud has glycine (metadata) + l-theanine (which is NOT in local → must drop).
    const cloudGet = {
      data: {
        stackId: 's1',
        name: 'My Stack',
        supplements: [
          { slug: 'glycine', dosage: '3g', timing: 'Evening', notes: null, brandName: null, position: 0 },
          { slug: 'l-theanine', dosage: '200mg', timing: null, notes: null, brandName: null, position: 1 },
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
        return jsonRes(cloudGet);
      }),
    );

    await stack.handler({ action: 'push' });
    // membership = local exactly (l-theanine dropped, magnesium added)
    expect(new Set(pushedItems.map((i) => i.slug))).toEqual(new Set(['magnesium', 'glycine']));
    // glycine kept its metadata; magnesium added with no dosage
    expect(pushedItems.find((i) => i.slug === 'glycine')?.dosage).toBe('3g');
    expect(pushedItems.find((i) => i.slug === 'magnesium')?.dosage).toBeFalsy();
  });

  it('list works offline (no token required)', async () => {
    delete process.env.SUPSTACK_TOKEN;
    addToStack('magnesium');
    const res = await stack.handler({ action: 'list' });
    expect(res.stack.map((i) => i.slug)).toEqual(['magnesium']);
  });

  it('add carries dose/timing/brand metadata into list', async () => {
    delete process.env.SUPSTACK_TOKEN;
    await stack.handler({ action: 'add', slug: 'Magnesium', dose: '400mg', timing: 'bedtime' });
    const res = await stack.handler({ action: 'list' });
    expect(res.stack[0]).toEqual({ slug: 'magnesium', dosage: '400mg', timing: 'bedtime' });
    // Re-adding merges new metadata without losing the rest.
    await stack.handler({ action: 'add', slug: 'magnesium', brand: 'Acme' });
    const after = await stack.handler({ action: 'list' });
    expect(after.stack[0]).toEqual({ slug: 'magnesium', dosage: '400mg', timing: 'bedtime', brand: 'Acme' });
  });

  it('pull preserves cloud metadata locally (brandName → brand)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes({
          data: {
            stackId: 's1',
            name: 'My Stack',
            supplements: [
              {
                slug: 'magnesium',
                dosage: '300mg',
                timing: 'PM',
                notes: null,
                brandName: 'Acme',
                position: 0,
              },
            ],
          },
        }),
      ),
    );
    const res = await stack.handler({ action: 'pull' });
    expect(res.stack[0]).toEqual({ slug: 'magnesium', dosage: '300mg', timing: 'PM', brand: 'Acme' });
  });
});
