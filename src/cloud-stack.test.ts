import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCloudStack, NotLoggedInError, putCloudStack, putCloudStackWithMeta } from './cloud-stack';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const cloudStack = (slugs: string[]): unknown => ({
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
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-cloud-'));
  process.env.SUPSTACK_HOME = home; // isolate from the real ~/.supstack
  delete process.env.SUPSTACK_TOKEN;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('cloud-stack', () => {
  it('throws NotLoggedInError without a token', async () => {
    await expect(getCloudStack()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(putCloudStack([{ slug: 'magnesium' }])).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('getCloudStack GETs /me/stack with the Bearer token', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(cloudStack(['magnesium', 'glycine'])));
    const out = await getCloudStack(fetchImpl as unknown as typeof fetch);
    expect(out.supplements.map((s) => s.slug)).toEqual(['magnesium', 'glycine']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/stack');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('putCloudStack PUTs the supplements with the Bearer token', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(cloudStack(['glycine'])));
    const out = await putCloudStack([{ slug: 'glycine' }], fetchImpl as unknown as typeof fetch);
    expect(out.supplements[0]?.slug).toBe('glycine');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/stack');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body)).supplements).toEqual([{ slug: 'glycine' }]);
  });
});

describe('putCloudStackWithMeta keeps what the server said about the write', () => {
  /**
   * ⚠️ Round 148. Round 92 found this client typing `meta` and discarding it on
   * the READ and fixed the read. The WRITE kept the original shape — it
   * declared `meta?: { warnings }` and returned `res.data` — so the annotation
   * was decorative and two things were invisible to `stack push` / `stack sync`:
   * the warnings the server computes on the write, and round 140's
   * `droppedOverCap` / `droppedMalformed`, added six rounds ago precisely so a
   * caller would learn part of their stack was neither stored NOR screened.
   */
  it('returns warnings and drop counts alongside the stack', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: { stackId: 's1', name: 'My Stack', supplements: [{ slug: 'magnesium' }] },
        meta: {
          warnings: [{ slug: 'magnesium', warnings: ['Needs care during pregnancy.'] }],
          droppedOverCap: 40,
          limit: 200,
          droppedOverCapNote: 'Only the first 200 were saved and safety-checked; 40 more were not.',
          droppedMalformed: [3],
        },
      }),
    );
    const { stack, meta } = await putCloudStackWithMeta(
      [{ slug: 'magnesium' }],
      fetchImpl as unknown as typeof fetch,
    );
    expect(stack.supplements).toHaveLength(1);
    expect(meta.warnings[0]?.warnings[0]).toMatch(/pregnan/i);
    expect(meta.droppedOverCap).toBe(40);
    expect(meta.droppedOverCapNote).toMatch(/safety-checked/);
    expect(meta.droppedMalformed).toEqual([3]);
  });

  it('defaults warnings to an empty list when the server sends no meta', async () => {
    // Anti-vacuity: the accessor must not throw for a clean write.
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ data: { stackId: 's1', name: 'My Stack', supplements: [] } }));
    const { meta } = await putCloudStackWithMeta([], fetchImpl as unknown as typeof fetch);
    expect(meta.warnings).toEqual([]);
    expect(meta.droppedOverCap).toBeUndefined();
  });
});
