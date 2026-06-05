import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed, apiPost } from './http';
import { bold, dim } from './output';

export interface HealthProfile {
  weight: number;
  weightUnit: string;
  age: number;
  biologicalSex: string;
  isPregnant: boolean;
  isNursing: boolean;
  healthConditions: string[];
  medications: string[];
  primaryGoals: string[];
}

/** Fields settable via `profile set`. camelCase → the API. */
export interface ProfilePatch {
  age?: number;
  weight?: number;
  weightUnit?: string;
  biologicalSex?: string;
  isPregnant?: boolean;
  isNursing?: boolean;
  healthConditions?: string[];
  medications?: string[];
  primaryGoals?: string[];
}

function requireToken(): string {
  const token = getToken();
  if (!token) throw new NotLoggedInError();
  return token;
}

export async function getProfile(fetchImpl?: typeof fetch): Promise<HealthProfile | null> {
  const res = await apiGetAuthed<{ data: HealthProfile | null }>('/me/profile', requireToken(), {
    fetchImpl,
  });
  return res.data;
}

export async function setProfile(patch: ProfilePatch, fetchImpl?: typeof fetch): Promise<HealthProfile> {
  const res = await apiPost<{ data: HealthProfile }>('/me/profile', patch, {
    bearer: requireToken(),
    method: 'PUT',
    fetchImpl,
  });
  return res.data;
}

// ─── Option parsing ──────────────────────────────────────────────────────

const csv = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Build a ProfilePatch from `profile set` CLI options. Returns the patch plus a
 * validation error string (or null). Only provided options are included.
 */
export function patchFromOptions(opts: Record<string, unknown>): {
  patch: ProfilePatch;
  error: string | null;
} {
  const patch: ProfilePatch = {};
  if (opts.age !== undefined) {
    const age = Number(opts.age);
    if (!Number.isInteger(age) || age < 13 || age > 120)
      return { patch, error: '--age must be an integer 13–120.' };
    patch.age = age;
  }
  if (opts.weight !== undefined) {
    const w = Number(opts.weight);
    if (!Number.isFinite(w) || w <= 0 || w > 1000)
      return { patch, error: '--weight must be between 0 and 1000.' };
    patch.weight = w;
  }
  if (opts.weightUnit !== undefined) {
    if (opts.weightUnit !== 'kg' && opts.weightUnit !== 'lbs')
      return { patch, error: '--weight-unit must be kg or lbs.' };
    patch.weightUnit = opts.weightUnit;
  }
  if (opts.sex !== undefined) {
    if (opts.sex !== 'male' && opts.sex !== 'female')
      return { patch, error: '--sex must be male or female.' };
    patch.biologicalSex = opts.sex;
  }
  if (typeof opts.conditions === 'string') patch.healthConditions = csv(opts.conditions);
  if (typeof opts.medications === 'string') patch.medications = csv(opts.medications);
  if (typeof opts.goals === 'string') patch.primaryGoals = csv(opts.goals);
  return { patch, error: null };
}

// ─── Output ──────────────────────────────────────────────────────────────

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function renderProfile(p: HealthProfile): void {
  out(bold('Your profile'));
  out(`  Age           ${p.age}`);
  out(`  Sex           ${p.biologicalSex}`);
  out(`  Weight        ${p.weight} ${p.weightUnit}`);
  if (p.biologicalSex === 'female' && (p.isPregnant || p.isNursing)) {
    out(
      `  Status        ${[p.isPregnant && 'pregnant', p.isNursing && 'nursing'].filter(Boolean).join(', ')}`,
    );
  }
  if (p.healthConditions.length) out(`  Conditions    ${p.healthConditions.join(', ')}`);
  if (p.medications.length) out(`  Medications   ${p.medications.join(', ')}`);
  if (p.primaryGoals.length) out(`  Goals         ${p.primaryGoals.join(', ')}`);
}

/** `supstack profile` — show the health profile. */
export async function runProfileShow(asJson: boolean): Promise<void> {
  const profile = await getProfile();
  if (asJson) {
    out(JSON.stringify({ profile }, null, 2));
    return;
  }
  if (!profile) {
    out(dim('No profile set yet.') + ' Set one with `supstack profile set --age 30 --sex male --weight 75`.');
    return;
  }
  renderProfile(profile);
}

/** `supstack profile set [options]` — update fields. */
export async function runProfileSet(opts: Record<string, unknown>, asJson: boolean): Promise<void> {
  const { patch, error } = patchFromOptions(opts);
  if (error) {
    process.stderr.write(error + '\n');
    process.exitCode = 1;
    return;
  }
  if (Object.keys(patch).length === 0) {
    process.stderr.write('Nothing to set. Try `supstack profile set --age 30 --sex male --weight 75`.\n');
    process.exitCode = 1;
    return;
  }
  const profile = await setProfile(patch);
  if (asJson) {
    out(JSON.stringify({ profile }, null, 2));
    return;
  }
  out(dim('Profile updated.'));
  renderProfile(profile);
}
