import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildInput, parseArgNames } from './args';
import type { AnyCapability } from './capability';

describe('parseArgNames', () => {
  it('extracts required, optional, and variadic arg names', () => {
    expect(parseArgNames('<a> <b>')).toEqual(['a', 'b']);
    expect(parseArgNames('[query]')).toEqual(['query']);
    expect(parseArgNames('<a> <b> [c]')).toEqual(['a', 'b', 'c']);
    expect(parseArgNames('<supplements...>')).toEqual(['supplements']);
    expect(parseArgNames('<first> <rest...>')).toEqual(['first', 'rest']);
    expect(parseArgNames(undefined)).toEqual([]);
  });
});

/** Minimal fake capability carrying just the fields buildInput touches. */
function cap(args: string | undefined, schema: z.ZodTypeAny): AnyCapability {
  return {
    name: 'x',
    description: '',
    inputSchema: schema,
    cli: { command: 'x', args },
    mcp: { toolName: 'x', description: '' },
    handler: async () => undefined,
    format: { text: () => '', json: () => undefined },
  };
}

describe('buildInput', () => {
  it('zips positionals onto arg names and validates', () => {
    const c = cap('<a> <b>', z.object({ a: z.string(), b: z.string() }));
    expect(buildInput(c, ['x', 'y'], {})).toEqual({ a: 'x', b: 'y' });
  });

  it('maps a variadic positional (array) to its field', () => {
    const c = cap('<supplements...>', z.object({ supplements: z.array(z.string()).min(2) }));
    expect(buildInput(c, [['mag', 'gly']], {})).toEqual({ supplements: ['mag', 'gly'] });
  });

  it('merges options but drops reserved CLI flags (json, cache)', () => {
    const c = cap('<a>', z.object({ a: z.string(), limit: z.coerce.number().optional() }));
    const out = buildInput(c, ['x'], { limit: '5', json: true, cache: false });
    expect(out).toEqual({ a: 'x', limit: 5 });
  });

  it('throws ZodError on invalid input', () => {
    const c = cap('<supplements...>', z.object({ supplements: z.array(z.string()).min(2, 'need 2') }));
    expect(() => buildInput(c, [['only-one']], {})).toThrow(z.ZodError);
  });
});
