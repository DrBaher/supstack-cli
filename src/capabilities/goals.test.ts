import { afterEach, describe, expect, it, vi } from 'vitest';

import { goals } from './goals';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

const GOALS = {
  data: [
    { id: 'deep-sleep', name: 'Improve deep sleep quality', category: 'sleep' },
    { id: 'fall-asleep-faster', name: 'Fall asleep faster', category: 'sleep' },
    { id: 'sharpen-focus', name: 'Sharpen focus', category: 'mental' },
    { id: 'build-strength', name: 'Build strength & muscle', category: 'performance' },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('goals capability', () => {
  it('lists every goal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(GOALS)));
    const out = await goals.handler({});
    expect(out).toHaveLength(4);
    expect(out.map((g) => g.id)).toContain('deep-sleep');
  });

  it('filters by category', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(GOALS)));
    const out = await goals.handler({ category: 'Sleep' }); // case-insensitive
    expect(out.map((g) => g.id)).toEqual(['deep-sleep', 'fall-asleep-faster']);
  });

  it('filters by a free-text query (matches id or name)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(GOALS)));
    expect((await goals.handler({ query: 'focus' })).map((g) => g.id)).toEqual(['sharpen-focus']);
    expect((await goals.handler({ query: 'strength' })).map((g) => g.id)).toEqual(['build-strength']);
  });

  it('renders goals grouped by category', () => {
    const text = goals.format.text(GOALS.data as never);
    expect(text).toContain('sleep');
    expect(text).toContain('deep-sleep');
    expect(text).toContain('Improve deep sleep quality');
    expect(text).toContain('mental');
  });
});
