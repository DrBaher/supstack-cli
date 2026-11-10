import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { printSafetyScreen } from './experiments';

/**
 * 14 October 2026: `experiments start`, `check-in` and `list` received the
 * caller's population screen (`safety`) and printed it only under `--json`.
 * A warn, or `unavailable` (nobody screened this), never reached the terminal.
 */
describe('CLI prints the safety screen it receives', () => {
  const lines: string[] = [];
  afterEach(() => {
    lines.length = 0;
    vi.restoreAllMocks();
  });
  function capture() {
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  }

  it('prints every risk and the unchecked axes, word for word', () => {
    capture();
    printSafetyScreen({ level: 'warn', risks: ['Risk one.', 'Risk two.'], uncheckedAxes: ['smoking'] });
    const text = lines.join('\n');
    expect(text).toContain('Risk one.');
    expect(text).toContain('Risk two.');
    expect(text).toContain('smoking');
  });

  it('prints the unavailable notice', () => {
    capture();
    printSafetyScreen({
      level: 'unavailable',
      risks: ['Could not read your health profile, so this experiment was not safety-screened.'],
    });
    expect(lines.join('\n')).toContain('not safety-screened');
  });

  it('prints nothing for a clean screen', () => {
    capture();
    printSafetyScreen(null);
    expect(lines).toHaveLength(0);
  });

  it('start, check-in and list all call it (derived from the source)', () => {
    const src = readFileSync(join(__dirname, 'experiments.ts'), 'utf8');
    for (const fn of ['runExperimentStart', 'runExperimentCheckIn', 'runExperimentsList']) {
      const start = src.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const next = src.indexOf('\nexport ', start + 10);
      const body = src.slice(start, next === -1 ? undefined : next);
      expect(body, `${fn} must print the safety screen`).toMatch(/printSafetyScreen\(/);
    }
    // Every CLI type that carries `safety` is printed somewhere.
    expect(src.match(/^\s+safety\??: \{/gm)?.length ?? 0).toBe(3);
  });

  it('the MCP start and check-in tools tell the model to relay it', () => {
    const mcp = readFileSync(join(__dirname, 'mcp-authed.ts'), 'utf8');
    expect(mcp).toMatch(/On a successful start, when `safety` is set, relay each of `safety\.risks`/);
    expect(mcp).toMatch(
      /When the result carries `safety`, relay each of `safety\.risks` after the instruction/,
    );
  });
});
