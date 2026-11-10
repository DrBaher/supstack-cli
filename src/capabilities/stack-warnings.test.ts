import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const STACK = readFileSync(new URL('./stack.ts', import.meta.url), 'utf-8');
const CLOUD = readFileSync(new URL('../cloud-stack.ts', import.meta.url), 'utf-8');

/**
 * ⚠️ Round 93 of the human persona audit (tracked in the app repo's
 * docs/data-audits-ledger.md).
 *
 * `/me/stack` returns `meta.warnings` — the population and medication warnings
 * the SERVER already computed for this caller — and this client typed the
 * response as `{ data }` and threw the rest away. The warnings never reached
 * the rendering layer, so a CLI user viewing their cloud stack was shown
 * supplements the web app would have flagged, silently.
 *
 * The CLI being a thin client over the public API is exactly why dropping a
 * field the API computed is a safety gap and not a formatting choice.
 */
describe('the cloud stack carries the server’s warnings', () => {
  it('the client keeps meta instead of discarding it', () => {
    expect(CLOUD).toContain('getCloudStackWithWarnings');
    expect(CLOUD).toMatch(/meta\?: \{ warnings\?: StackWarning\[\] \}/);
    expect(CLOUD).toContain('res.meta?.warnings ?? []');
  });

  it('the pull path uses the warning-preserving fetch', () => {
    const pull = STACK.slice(STACK.indexOf("case 'pull'"), STACK.indexOf("case 'push'"));
    expect(pull).toContain('getCloudStackWithWarnings');
    expect(pull).toContain('warnings,');
  });

  it('and the human output renders them', () => {
    expect(STACK).toContain('r.warnings ?? []');
    expect(STACK).toMatch(/yellow\('⚠'\)/);
  });

  /**
   * ⚠️ On the RESULT type, not computed at render time — `--json` consumers and
   * MCP clients read the same object, and an MCP client relaying a stack is as
   * much a safety surface as the terminal.
   */
  it('json consumers get them too', () => {
    const type = STACK.slice(STACK.indexOf('interface StackResult'), STACK.indexOf('const InputSchema'));
    expect(type).toContain('warnings?: StackWarning[]');
  });

  /**
   * Anti-vacuity: the warnings must be rendered per supplement, not collapsed
   * into a count. "3 warnings" tells a reader nothing about which item.
   */
  it('each warning names its supplement', () => {
    expect(STACK).toMatch(/\$\{w\.slug\}/);
  });
});
