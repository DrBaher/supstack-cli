import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const EXPERIMENTS = readFileSync(new URL('./experiments.ts', import.meta.url), 'utf-8');
const CLOUD = readFileSync(new URL('./cloud-stack.ts', import.meta.url), 'utf-8');

/**
 * ⚠️ Round 94 of the human persona audit. Narrower than it first looked, and
 * the correction is the point.
 *
 * `/me/experiments` returns a per-experiment `safety` verdict computed against
 * the caller's CURRENT profile, and `ExperimentListItem` did not declare it. My
 * first reading was that the CLI "dropped" it and MCP clients therefore relayed
 * experiments with the contraindication missing. That was WRONG: `return
 * res.data` hands back parsed JSON, and a TypeScript type does not strip fields
 * at runtime. MCP clients were receiving `safety` all along.
 *
 * Round 93's defect WAS real — `getCloudStack` returned `res.data` and threw
 * `meta` away, which loses data at runtime. The difference between the two is
 * exactly the difference between a type that under-describes a payload and code
 * that discards one, and it is worth not conflating them.
 *
 * What remains here is still worth fixing: an undeclared field cannot be
 * rendered, cannot be relied on, and is one `.map()` away from being genuinely
 * dropped. The type is the contract.
 */
describe('the CLI declares the safety fields the API sends', () => {
  it('an experiment carries the caller’s current verdict', () => {
    /**
     * ⚠️ Round 158 widened the union. This pinned the exact literal
     * `'block' | 'warn'`, so adding `'unrecognised'` — a level the API started
     * sending for a supplement the corpus no longer carries — read as a
     * regression. Same pinned-literal breakage rounds 64, 74, 77, 113 and 137
     * each hit.
     *
     * The property this test is about is that the field EXISTS and carries the
     * verdict levels the API can send, so it now asserts the two that must
     * always be there rather than the exact shape of the union.
     *
     * ⚠️ And it is whitespace-tolerant, which the previous version was not: the
     * declaration outgrew one line when `uncheckedAxes` joined it, and a
     * REFORMAT read as a missing field. That is the same pinned-literal
     * brittleness the comment above is about, one axis over — the regex pinned
     * the layout as well as the content.
     */
    expect(EXPERIMENTS).toMatch(
      /safety[?]?:\s*\{[^}]*level:[^;]*'block'[^;]*'warn'[^;]*;[^}]*risks:\s*string\[\];[^}]*\}\s*\|\s*null;/,
    );
  });

  /**
   * ⚠️ The level that means "we screened, found nothing, and could not look at
   * the thing that decides this entry".
   *
   * `safety: null` used to be the answer for `beta-carotene` on a profile with
   * no smoking status — indistinguishable from screened-and-clean, on the entry
   * whose contraindication is a randomised +18% lung-cancer signal. A client
   * whose type omits the level cannot render it, so the type has to move with
   * the API. `uncheckedAxes` rides alongside the level because a finding and an
   * unanswered axis can be true at once.
   */
  it('and declares the unchecked level, plus the axis list that survives a real finding', () => {
    expect(EXPERIMENTS).toContain("'unchecked'");
    expect(EXPERIMENTS).toContain('uncheckedAxes?: string[]');
    // Every declaration of the payload, not just the first one.
    const levelDecls = EXPERIMENTS.match(/level: '(?:block|warn)'[^;]*;/g) ?? [];
    expect(levelDecls.length, 'no safety payload declarations found').toBeGreaterThan(1);
    for (const d of levelDecls) expect(d, d).toContain("'unchecked'");
  });

  it('and declares the unrecognised level the API sends for a removed supplement', () => {
    // ⚠️ Round 158. `known === false` is not `safety: null`; the API says so
    // explicitly now, and a client whose type omits the level cannot render it.
    expect(EXPERIMENTS).toContain("'unrecognised'");
  });

  /**
   * ⚠️ Anti-vacuity, and the assertion that would have caught round 93: a type
   * declaring the field is worth nothing if the fetch discards the envelope it
   * arrives in. `meta` must survive the unwrap.
   */
  it('and the stack fetch keeps the envelope its warnings arrive in', () => {
    expect(CLOUD).toContain('res.meta?.warnings ?? []');
    expect(CLOUD).not.toMatch(/getCloudStackWithWarnings[\s\S]{0,300}return res\.data;\s*\}/);
  });

  /**
   * Derived: any CLI function unwrapping an API envelope with `return res.data`
   * discards everything outside `data`. That is fine when the endpoint puts
   * nothing there and a silent safety loss when it does — round 93 exactly. Each
   * such call site is listed with the reason it is safe.
   */
  it('every bare data-unwrap is on an endpoint with nothing safety-bearing outside data', () => {
    // ⚠️ Eight (six, then the correction route, then the restart route), not the two I assumed. Each was checked against its endpoint:
    //   /me/experiments          → meta is `{ total }`, a count
    //   /me/experiments/:id      → no meta
    //   /me/experiments/protocol → no meta, no safety
    //   POST experiments         → no meta
    //   POST check-in            → safety is INSIDE data
    //   POST abandon             → no meta
    //   POST correction          → no meta; a refusal is a 409 whose
    //                              safetyAction/problems the CLI reads from
    //                              the ApiError body (reportCorrectionRefusal)
    //   POST restart             → no meta; `safety` is INSIDE data, and a
    //                              refusal is a 409 whose safetyAction and
    //                              restartRecordProblems the CLI reads from
    //                              the ApiError body (reportRestartRefusal)
    //   POST safety-report       → no meta (ruling 601); `safety` and
    //                              `safetyAction` are INSIDE data, and a
    //                              refusal's safetyAction is read from the
    //                              ApiError body (reportMissing)
    // So unwrapping loses nothing here. The point of pinning the count is that
    // a NINTH unwrap has not been checked, and round 93 is what an unchecked
    // one costs.
    const bare = [...EXPERIMENTS.matchAll(/return res\.data;/g)].length;
    expect(bare, 'a new data-unwrap needs its endpoint checked for a meta envelope').toBe(9);
  });

  it('the check-in result declares the level that means nobody screened it', () => {
    expect(EXPERIMENTS).toMatch(/'block' \| 'warn' \| 'unavailable'/);
  });
});
