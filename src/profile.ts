import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed, apiPost } from './http';
import { bold, dim } from './output';

export interface HealthProfile {
  weight: number | null;
  weightUnit: string;
  age: number | null;
  biologicalSex: string | null;
  isPregnant: boolean;
  isNursing: boolean;
  healthConditions: string[];
  medications: string[];
  primaryGoals: string[];
  currentSupplements: string[];
  sleepHours: number | null;
  exerciseFrequency: string | null;
  dietType: string | null;
  stressLevel: string | null;
  tracksBloodwork: boolean;
  profileCompletedAt: string | null;
}

/** Fields settable via `profile set`. camelCase → the API. */
export interface ProfilePatch {
  age?: number;
  weight?: number;
  weightUnit?: string;
  biologicalSex?: string;
  healthConditions?: string[];
  medications?: string[];
  primaryGoals?: string[];
  currentSupplements?: string[];
  sleepHours?: number;
  exerciseFrequency?: string;
  dietType?: string;
  stressLevel?: string;
  tracksBloodwork?: boolean;
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

export async function clearProfile(fetchImpl?: typeof fetch): Promise<void> {
  await apiPost('/me/profile', undefined, { bearer: requireToken(), method: 'DELETE', fetchImpl });
}

// ─── Option parsing ──────────────────────────────────────────────────────

const csv = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EXERCISE = ['none', '1-2', '3-4', '5+'];
const DIET = ['omnivore', 'vegetarian', 'vegan', 'keto', 'paleo', 'mediterranean', 'other'];
const STRESS = ['low', 'moderate', 'high', 'very-high'];

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
  if (typeof opts.currentSupplements === 'string') patch.currentSupplements = csv(opts.currentSupplements);
  if (opts.sleepHours !== undefined) {
    const h = Number(opts.sleepHours);
    if (!Number.isFinite(h) || h < 0 || h > 24)
      return { patch, error: '--sleep-hours must be between 0 and 24.' };
    patch.sleepHours = h;
  }
  if (opts.exercise !== undefined) {
    if (!EXERCISE.includes(opts.exercise as string))
      return { patch, error: `--exercise must be one of: ${EXERCISE.join(', ')}.` };
    patch.exerciseFrequency = opts.exercise as string;
  }
  if (opts.diet !== undefined) {
    if (!DIET.includes(opts.diet as string))
      return { patch, error: `--diet must be one of: ${DIET.join(', ')}.` };
    patch.dietType = opts.diet as string;
  }
  if (opts.stress !== undefined) {
    if (!STRESS.includes(opts.stress as string))
      return { patch, error: `--stress must be one of: ${STRESS.join(', ')}.` };
    patch.stressLevel = opts.stress as string;
  }
  if (opts.tracksBloodwork !== undefined) patch.tracksBloodwork = Boolean(opts.tracksBloodwork);
  return { patch, error: null };
}

// ─── Output ──────────────────────────────────────────────────────────────

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function renderProfile(p: HealthProfile): void {
  const row = (label: string, value: string | number | null | undefined): void => {
    if (value !== null && value !== undefined && value !== '') out(`  ${label.padEnd(13)} ${value}`);
  };
  out(bold('Your profile'));
  row('Age', p.age);
  row('Sex', p.biologicalSex);
  row('Weight', p.weight !== null ? `${p.weight} ${p.weightUnit}` : null);
  if (p.biologicalSex === 'female' && (p.isPregnant || p.isNursing)) {
    row('Status', [p.isPregnant && 'pregnant', p.isNursing && 'nursing'].filter(Boolean).join(', '));
  }
  row('Conditions', p.healthConditions.length ? p.healthConditions.join(', ') : null);
  row('Medications', p.medications.length ? p.medications.join(', ') : null);
  row('Goals', p.primaryGoals.length ? p.primaryGoals.join(', ') : null);
  row('Supplements', p.currentSupplements.length ? p.currentSupplements.join(', ') : null);
  row('Sleep', p.sleepHours !== null ? `${p.sleepHours}h` : null);
  row('Exercise', p.exerciseFrequency);
  row('Diet', p.dietType);
  row('Stress', p.stressLevel);
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

/** `supstack profile clear` — delete the health profile. */
export async function runProfileClear(): Promise<void> {
  await clearProfile();
  out('Profile cleared.');
}
