import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotLoggedInError } from './cloud-stack';
import { clearProfile, getProfile, patchFromOptions, setProfile } from './profile';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
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
});
