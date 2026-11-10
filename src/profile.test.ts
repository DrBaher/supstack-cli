import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotLoggedInError } from './cloud-stack';
import {
  clearProfile,
  getProfile,
  patchFromOptions,
  runProfileShow,
  setProfile,
  setProfileWithMeta,
} from './profile';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((s: string): boolean => (lines.push(String(s)), true)) as any;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
}

const sampleProfile = (age: number): unknown => ({
  data: {
    age,
    biologicalSex: 'male',
    weight: 80,
    weightUnit: 'kg',
    isPregnant: false,
    isNursing: false,
    healthConditions: [],
    medications: [],
    primaryGoals: [],
    currentSupplements: [],
    sleepHours: null,
    exerciseFrequency: null,
    dietType: null,
    stressLevel: null,
    tracksBloodwork: false,
    profileCompletedAt: null,
  },
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-profile-'));
  process.env.SUPSTACK_HOME = home;
  delete process.env.SUPSTACK_TOKEN;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('patchFromOptions — smoking', () => {
  /**
   * The CLI could DISPLAY smoking (`profile show` prints a Smoking row) while
   * having no way to SET it. A field that renders but cannot be written reads
   * as "not stated" forever, and on this axis "not stated" is exactly what a
   * smoker looks like — so the beta-carotene gate never fired for any CLI user.
   */
  it('accepts each of the three states', () => {
    for (const status of ['never', 'former', 'current']) {
      const { patch, error } = patchFromOptions({ smoking: status });
      expect(error).toBeNull();
      expect(patch.smokingStatus).toBe(status);
    }
  });

  it('rejects anything else rather than storing it', () => {
    // The column has a CHECK constraint; an unvalidated value would fail the
    // whole PATCH and take every other field in the same command with it.
    for (const bad of ['yes', 'smoker', 'NEVER', 'unspecified', 'true']) {
      const { patch, error } = patchFromOptions({ smoking: bad });
      expect(error, `--smoking ${bad}`).toMatch(/must be one of/);
      expect(patch.smokingStatus).toBeUndefined();
    }
  });

  it('leaves the field untouched when the flag is absent', () => {
    // ⚠️ Omission is UNKNOWN, never 'never'. Defaulting an unset flag to
    // 'never' would state, on the reader's behalf, that they do not smoke.
    const { patch, error } = patchFromOptions({ age: 40 });
    expect(error).toBeNull();
    expect('smokingStatus' in patch).toBe(false);
  });
});

describe('patchFromOptions', () => {
  it('builds a patch from valid options (numbers coerced, CSV split)', () => {
    const { patch, error } = patchFromOptions({
      age: '35',
      sex: 'male',
      weight: '80',
      weightUnit: 'kg',
      conditions: 'a, b',
      medications: 'x',
      goals: 'deep-sleep,focus',
    });
    expect(error).toBeNull();
    expect(patch).toEqual({
      age: 35,
      biologicalSex: 'male',
      weight: 80,
      weightUnit: 'kg',
      healthConditions: ['a', 'b'],
      medications: ['x'],
      primaryGoals: ['deep-sleep', 'focus'],
    });
  });

  it('rejects out-of-range / invalid values', () => {
    expect(patchFromOptions({ age: '200' }).error).toMatch(/age/);
    expect(patchFromOptions({ sex: 'other' }).error).toMatch(/sex/);
    expect(patchFromOptions({ weight: '0' }).error).toMatch(/weight/);
    expect(patchFromOptions({ weightUnit: 'stone' }).error).toMatch(/weight-unit/);
    expect(patchFromOptions({ sleepHours: '30' }).error).toMatch(/sleep-hours/);
    expect(patchFromOptions({ exercise: 'sometimes' }).error).toMatch(/exercise/);
    expect(patchFromOptions({ diet: 'carnivore' }).error).toMatch(/diet/);
    expect(patchFromOptions({ stress: 'extreme' }).error).toMatch(/stress/);
  });

  it('builds lifestyle fields', () => {
    const { patch, error } = patchFromOptions({
      sleepHours: '7.5',
      exercise: '3-4',
      diet: 'keto',
      stress: 'low',
      currentSupplements: 'magnesium, creatine',
      tracksBloodwork: true,
    });
    expect(error).toBeNull();
    expect(patch).toEqual({
      sleepHours: 7.5,
      exerciseFrequency: '3-4',
      dietType: 'keto',
      stressLevel: 'low',
      currentSupplements: ['magnesium', 'creatine'],
      tracksBloodwork: true,
    });
  });

  it('is empty when no recognised options are present', () => {
    const { patch, error } = patchFromOptions({ json: true });
    expect(error).toBeNull();
    expect(Object.keys(patch)).toHaveLength(0);
  });
});

describe('profile wire helpers', () => {
  it('require a token', async () => {
    await expect(getProfile()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(setProfile({ age: 30 })).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('getProfile GETs /me/profile with the Bearer token', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(sampleProfile(35)));
    const p = await getProfile(fetchImpl as unknown as typeof fetch);
    expect(p?.age).toBe(35);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/profile');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('setProfile PUTs the patch with the Bearer token', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(sampleProfile(40)));
    const p = await setProfile({ age: 40 }, fetchImpl as unknown as typeof fetch);
    expect(p.age).toBe(40);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/profile');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ age: 40 });
  });

  it('clearProfile DELETEs /me/profile with the Bearer token', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ status: 'cleared' }));
    await clearProfile(fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/profile');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('runProfileShow renders the profile (and a no-profile hint)', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    // Null profile → hint.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ data: null })));
    expect(await captureStdout(() => runProfileShow(false))).toContain('No profile set yet');
    vi.unstubAllGlobals();
    // Populated.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: {
            age: 44,
            biologicalSex: 'male',
            weight: 83,
            weightUnit: 'kg',
            isPregnant: false,
            isNursing: false,
            healthConditions: [],
            medications: [],
            primaryGoals: ['build-strength'],
            currentSupplements: [],
            sleepHours: null,
            exerciseFrequency: null,
            dietType: null,
            stressLevel: null,
            tracksBloodwork: false,
            profileCompletedAt: null,
          },
        }),
      ),
    );
    const out = await captureStdout(() => runProfileShow(false));
    expect(out).toContain('Your profile');
    expect(out).toContain('44');
    expect(out).toContain('83 kg');
    expect(out).toContain('build-strength');
    vi.unstubAllGlobals();
  });
});

describe('setProfileWithMeta keeps what the server could not interpret', () => {
  /**
   * ⚠️ Round 149. `PUT /me/profile` reports `meta.unrecognisedConditions` — the
   * conditions it stored but cannot act on — and this client typed the response
   * as `{ data }`, dropping the field before anything could render it.
   *
   * The web says this (round 135's `UncheckedConditionsNotice`) and the
   * assistant's system prompt says it. The CLI and MCP said nothing, and MCP is
   * where a MODEL sets the profile for someone and reports back.
   */
  it('returns the unrecognised conditions alongside the saved profile', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { healthConditions: ['kidney-disease', "hashimoto's"] },
          meta: { unrecognisedConditions: ["hashimoto's"] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { profile, meta } = await setProfileWithMeta(
      { healthConditions: ['kidney-disease', "hashimoto's"] },
      fetchImpl as unknown as typeof fetch,
    );
    expect(profile).toBeTruthy();
    expect(meta.unrecognisedConditions).toEqual(["hashimoto's"]);
  });

  it('is empty when the server understood everything', async () => {
    // Anti-vacuity: the accessor must not invent a caveat for a clean write.
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { conditions: ['kidney-disease'] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { meta } = await setProfileWithMeta(
      { healthConditions: ['kidney-disease'] },
      fetchImpl as unknown as typeof fetch,
    );
    expect(meta.unrecognisedConditions).toBeUndefined();
  });
});

describe('patchFromOptions --enzyme-allergy (owner ruling 192.3)', () => {
  it('records culprits from the controlled list, unknown included', () => {
    const { patch, error } = patchFromOptions({ enzymeAllergy: 'lactase, unknown' });
    expect(error).toBeNull();
    expect(patch.enzymeAllergies).toEqual([{ culprit: 'lactase' }, { culprit: 'unknown' }]);
  });

  it('none clears the stored list', () => {
    const { patch, error } = patchFromOptions({ enzymeAllergy: 'none' });
    expect(error).toBeNull();
    expect(patch.enzymeAllergies).toEqual([]);
  });

  it('rejects an enzyme off the list rather than storing it', () => {
    const { patch, error } = patchFromOptions({ enzymeAllergy: 'lactose' });
    expect(error).toMatch(/--enzyme-allergy must be/);
    expect(patch.enzymeAllergies).toBeUndefined();
  });

  it('leaves the field untouched when the flag is absent', () => {
    const { patch } = patchFromOptions({ age: 40 });
    expect('enzymeAllergies' in patch).toBe(false);
  });
});
