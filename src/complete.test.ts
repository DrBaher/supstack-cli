import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { completeContext, resolveCompletions, runComplete } from './complete';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const slugMock = (): ReturnType<typeof vi.fn> =>
  vi.fn(() =>
    Promise.resolve(
      jsonRes({ data: [{ slug: 'magnesium' }, { slug: 'creatine' }], meta: { totalPages: 1 } }),
    ),
  );

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-complete-'));
  process.env.SUPSTACK_HOME = home;
});
afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_NO_ANON_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('completeContext', () => {
  it('completes top-level commands as the first token', () => {
    expect(completeContext([''])).toEqual({ kind: 'commands' });
    expect(completeContext(['rese'])).toEqual({ kind: 'commands' });
  });

  it('completes sub-actions at position 2 of a group', () => {
    expect(completeContext(['stack', ''])).toEqual({ kind: 'sub', command: 'stack' });
    expect(completeContext(['track', ''])).toEqual({ kind: 'sub', command: 'track' });
    expect(completeContext(['experiments', 'sh'])).toEqual({ kind: 'sub', command: 'experiments' });
  });

  it('completes supplement slugs in slug positions', () => {
    expect(completeContext(['research', ''])).toEqual({ kind: 'supplements' });
    expect(completeContext(['compare', 'magnesium', ''])).toEqual({ kind: 'supplements' });
    expect(completeContext(['interactions', 'a', 'b', ''])).toEqual({ kind: 'supplements' });
    expect(completeContext(['stack', 'add', ''])).toEqual({ kind: 'supplements' });
    expect(completeContext(['track', 'log', ''])).toEqual({ kind: 'supplements' });
  });

  it('completes goal ids after search --goal', () => {
    expect(completeContext(['search', '--goal', ''])).toEqual({ kind: 'goals' });
    expect(completeContext(['search', '-g', 'dee'])).toEqual({ kind: 'goals' });
  });

  it('returns none for ids, glossary terms, and flag words', () => {
    expect(completeContext(['experiments', 'show', ''])).toEqual({ kind: 'none' }); // id, not slug
    expect(completeContext(['define', ''])).toEqual({ kind: 'none' });
    expect(completeContext(['research', '--js'])).toEqual({ kind: 'none' }); // completing a flag
  });
});

describe('resolveCompletions', () => {
  it('prefix-filters command names', async () => {
    expect(await resolveCompletions(['rese'])).toContain('research');
    expect(await resolveCompletions(['rese'])).not.toContain('search');
  });

  it('prefix-filters sub-actions', async () => {
    expect(await resolveCompletions(['stack', 're'])).toEqual(['remove']);
  });

  it('resolves + filters supplement slugs via the data layer', async () => {
    const out = await resolveCompletions(['research', 'mag'], {
      fetchImpl: slugMock() as unknown as typeof fetch,
    });
    expect(out).toEqual(['magnesium']);
  });

  it('returns [] for a none context', async () => {
    expect(await resolveCompletions(['define', 'bio'])).toEqual([]);
  });
});

describe('runComplete', () => {
  it('prints newline-separated candidates and never mints an anon key', async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string): boolean => (lines.push(String(s)), true)) as any;
    try {
      await runComplete(['stack', '']);
    } finally {
      process.stdout.write = orig;
    }
    const out = lines.join('');
    expect(out).toContain('add');
    expect(out).toContain('sync');
    expect(process.env.SUPSTACK_NO_ANON_TOKEN).toBe('1');
  });
});
