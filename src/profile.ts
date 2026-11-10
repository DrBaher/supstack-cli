import { NotLoggedInError } from './cloud-stack';
import { getToken } from './config';
import { apiGetAuthed, apiPost } from './http';
import { bold, dim } from './output';

/**
 * The server's controlled culprit list (src/lib/supplements/enzyme-allergy.ts
 * ENZYME_IDS). Copied because this package cannot import the app, and held to
 * it by tests/lib/enzyme-allergy-culprit.test.ts.
 */
export const ENZYME_CULPRITS = [
  'lactase',
  'alpha-galactosidase',
  'myrosinase',
  'bromelain',
  'papain',
  'trypsin',
  'chymotrypsin',
  'pancreatin',
  'pepsin',
  'nattokinase',
  'serrapeptase',
  'dao',
  'an-pep',
  'protease',
  'amylase',
  'lipase',
  'cellulase',
  'unknown',
] as const;

export interface EnzymeAllergyRecord {
  /**
   * Pharmacist ruling 216: "product" is a reaction to any product, not an
   * enzyme (culprit is then "unknown" and ignored). Absent means "enzyme".
   */
  kind?: 'enzyme' | 'product' | null;
  culprit: (typeof ENZYME_CULPRITS)[number];
  /** kind "product": the available composition. */
  composition?: string | null;
  /** kind "product": allergy condition ids (wheat-allergy, ...), each a declared allergy. */
  allergens?: string[] | null;
  product?: string | null;
  productSlug?: string | null;
  /** Pharmacist ruling 200: manufacturer, formulation, label version or lot, dose and route. null = not known. */
  manufacturer?: string | null;
  formulation?: string | null;
  labelVersionOrLot?: string | null;
  dose?: string | null;
  route?: 'oral' | 'topical' | 'other' | 'unknown' | null;
  source?: string | null;
  reaction?: string | null;
  timing?: 'minutes' | 'hours' | 'later' | 'unknown' | null;
  professionallyConfirmed?: boolean | null;
  /** Assessed culprit or uncertain attribution. null is read as uncertain. */
  attribution?: 'assessed-culprit' | 'uncertain' | null;
  /** Honoured only on a confirmed, assessed culprit. */
  avoidanceScope?: 'enzyme' | 'product-or-source' | null;
  /** A clinician-documented alternative explanation or delabelling; retires the record's block. */
  clinicianReview?: {
    outcome: 'alternative-explanation' | 'delabelled';
    documentedBy: string;
    documentedOn: string;
    reference?: string | null;
  } | null;
  /**
   * Ruling 226, call 4. kind "product": other products of the same entry a
   * clinician or allergist reviewed individually as distinct from the culprit,
   * each with its own plan. The culprit itself is refused.
   */
  reviewedDistinctProducts?: Array<{
    product: string;
    manufacturer: string;
    labelVersionOrLot?: string | null;
    documentedBy: string;
    documentedOn: string;
    plan: string;
    reference?: string | null;
  }> | null;
}

/**
 * Pharmacist ruling 216: a vitamin E or niacin product the reader takes. No
 * number decides anything. An incomplete or non-nutritional record keeps the
 * optional suggestion withheld (more vitamin E, or red yeast rice beside
 * niacin).
 */
export interface DoseFormRecord {
  nutrient: 'vitamin-e' | 'niacin';
  product?: string | null;
  form?:
    | 'natural-alpha-tocopherol'
    | 'synthetic-alpha-tocopherol'
    | 'mixed-tocopherols'
    | 'tocotrienols'
    | 'water-soluble-tpgs'
    | 'in-a-multivitamin-or-blend'
    | 'nicotinic-acid'
    | 'nicotinamide'
    | 'inositol-hexanicotinate'
    | 'in-a-multivitamin-or-b-complex'
    | 'other'
    | 'unknown'
    | null;
  release?: 'immediate' | 'extended' | 'unknown' | null;
  amountPerDose?: number | null;
  unit?: 'mg' | 'IU' | 'unknown' | null;
  frequency?: string | null;
  indication?: string | null;
  basis?: 'nutritional' | 'higher-dose' | 'clinician-managed' | 'unknown' | null;
  otherProducts?: string | null;
  anticoagulant?: boolean | null;
  bleedingHistory?: boolean | null;
  clinicianPlan?: string | null;
  /**
   * Ruling 226: a review covers exactly the regimen it saw, by
   * `regimenFingerprint`. Missing or different, it covers nothing.
   */
  review?: {
    documentedBy: string;
    documentedOn: string;
    reference?: string | null;
    regimenFingerprint?: string | null;
  } | null;
  /** Ruling 226, call 3: the stack entry, row id and row version this record describes. */
  stackSlug?: string | null;
  stackItemId?: string | null;
  stackItemVersion?: string | null;
  /** Ruling 226, call 3: the medicine, exactly as written, this record describes. */
  medication?: string | null;
  /** Ruling 266 row 13: the stack row's product fingerprint when the record was written. */
  stackItemProduct?: string | null;
  /** Rulings 266 row 11 and 273: a stopped product, kept as history, no longer a current exposure. */
  currentUse?: 'not-current' | null;
  notCurrentSince?: string | null;
}

/**
 * Ruling 226, call 3. The fingerprint of the exact regimen a record states,
 * the same function as `regimenFingerprint` in src/lib/supplements/dose-form.ts
 * (this package cannot import the app; tests/lib/dose-form-ruling-226.test.ts
 * holds the two equal). A review written with it covers that regimen only.
 */
function fingerprintOf(r: DoseFormRecord, version: 'rf1' | 'rf2'): string {
  const parts = [
    r.nutrient,
    r.product,
    r.form,
    r.release,
    r.amountPerDose,
    r.unit,
    r.frequency,
    r.basis,
    r.anticoagulant,
    r.bleedingHistory,
    r.stackSlug,
    r.stackItemId,
    // rf1 bound the stack row's edit version too, so a notes-only edit of the
    // row lapsed a clinician review (ruling 242 call 3 objected). rf2 binds the
    // regimen and the product it is linked to, not the row's edit time.
    ...(version === 'rf1' ? [r.stackItemVersion] : []),
    r.medication,
  ].map((v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase()));
  let h = 0x811c9dc5;
  for (const ch of parts.join('\u0001')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${version}-${h.toString(16).padStart(8, '0')}`;
}

/**
 * Pharmacist ruling 242 call 3 (6 October 2026): "Notes-only edits should not
 * imply a new clinical injury or permanently require a clinician record when
 * no clinical regimen changed." So the fingerprint (`rf2`) is the regimen and
 * the product it is linked to, and no longer the stack row's edit version: an
 * edited row still lapses the MATCH (the reader confirms the record still
 * describes it), and a confirmed, unchanged regimen keeps its review. A change
 * to the regimen itself still lapses the review.
 */
export function regimenFingerprint(r: DoseFormRecord): string {
  return fingerprintOf(r, 'rf2');
}

/** The ruling-226 fingerprint (`rf1`, with the row version), still accepted for reviews written with it. */
export function legacyRegimenFingerprint(r: DoseFormRecord): string {
  return fingerprintOf(r, 'rf1');
}

/** Does the review's fingerprint cover this record as it stands? */
export function reviewCoversRegimen(r: DoseFormRecord): boolean {
  const fp = r.review?.regimenFingerprint;
  return Boolean(fp && (fp === regimenFingerprint(r) || fp === legacyRegimenFingerprint(r)));
}

/**
 * A review sent without a fingerprint is stamped with the regimen it is sent
 * with, the same as the web form does: the reader is stating that this exact
 * regimen was reviewed. Any later change lapses it.
 */
export function withReviewFingerprints(records: DoseFormRecord[]): DoseFormRecord[] {
  return records.map((r) => {
    if (!r.review || r.review.regimenFingerprint) return r;
    const { review, ...regimen } = r;
    return { ...r, review: { ...review, regimenFingerprint: regimenFingerprint(regimen as DoseFormRecord) } };
  });
}

export interface HealthProfile {
  weight: number | null;
  weightUnit: string;
  age: number | null;
  biologicalSex: string | null;
  isPregnant: boolean;
  isNursing: boolean;
  /** 'never' | 'former' | 'current'; null = not stated, which gates nothing. */
  smokingStatus: 'never' | 'former' | 'current' | null;
  /**
   * Recorded enzyme allergy reactions (owner ruling 192.3). `null` with
   * `enzymeAllergiesAvailable: false` means they could not be read, which is
   * not the same as none recorded.
   */
  enzymeAllergies?: EnzymeAllergyRecord[] | null;
  enzymeAllergiesAvailable?: boolean;
  /**
   * Vitamin E and niacin regimens (pharmacist ruling 216). `null` with
   * `doseFormRecordsAvailable: false` means they could not be read, which the
   * gates treat as an unknown regimen.
   */
  doseFormRecords?: DoseFormRecord[] | null;
  doseFormRecordsAvailable?: boolean;
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
  smokingStatus?: string;
  /** Replaces the stored list. `[]` clears it. */
  enzymeAllergies?: EnzymeAllergyRecord[];
  /** Replaces the stored list. `[]` clears it. */
  doseFormRecords?: DoseFormRecord[];
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
  return (await getProfileWithMeta(fetchImpl)).profile;
}

/** The read, keeping the server's clarification report (pharmacist ruling 417). */
export async function getProfileWithMeta(
  fetchImpl?: typeof fetch,
): Promise<{ profile: HealthProfile | null; meta: ProfileClarificationMeta }> {
  const res = await apiGetAuthed<{ data: HealthProfile | null; meta?: ProfileClarificationMeta }>(
    '/me/profile',
    requireToken(),
    {
      fetchImpl,
    },
  );
  return { profile: res.data, meta: res.meta ?? {} };
}

/**
 * Pharmacist ruling 417 (E-38): a stored condition that needs clarification
 * (the old combined bee or pollen allergy), and her note, verbatim. Reported by
 * `GET` and `PUT /me/profile`. The server still screens it at least as strictly
 * as before.
 */
export interface ProfileClarificationMeta {
  conditionsNeedingClarification?: string[];
  conditionClarificationNote?: string;
}

/** The clarification lines a human reader sees, empty when there is nothing to clarify. */
export function clarificationLines(meta: ProfileClarificationMeta): string[] {
  if (!meta.conditionsNeedingClarification?.length || !meta.conditionClarificationNote) return [];
  return meta.conditionsNeedingClarification.map((id) => `${id}: ${meta.conditionClarificationNote}`);
}

/** What the server could not interpret in a profile it nonetheless SAVED. */
export interface ProfileWriteMeta extends ProfileClarificationMeta {
  /**
   * Conditions stored verbatim because `resolveConditionId` returned null for
   * them. Nothing downstream gates on these — no contraindication, no
   * population verdict, no interaction warning.
   */
  unrecognisedConditions?: string[];
}

export async function setProfile(patch: ProfilePatch, fetchImpl?: typeof fetch): Promise<HealthProfile> {
  return (await setProfileWithMeta(patch, fetchImpl)).profile;
}

/**
 * The same write, keeping what the server said it could not interpret.
 *
 * ⚠️ Round 149. `PUT /me/profile` reports `meta.unrecognisedConditions` — the
 * conditions it stored but cannot act on — and this client typed the response
 * as `{ data: HealthProfile }`, so the field was dropped before anything could
 * render it.
 *
 * The web learned to say this in round 135 (`UncheckedConditionsNotice`) and
 * the assistant says it in its system prompt: "silence about them is not a
 * clean bill of health". The CLI and the MCP server said nothing at all — and
 * MCP is the channel where a MODEL sets the profile on someone's behalf and
 * reports back, so a dropped caveat becomes a confident summary.
 *
 * Round 148's shape one endpoint over, and round 92's before that.
 */
export async function setProfileWithMeta(
  patch: ProfilePatch,
  fetchImpl?: typeof fetch,
): Promise<{ profile: HealthProfile; meta: ProfileWriteMeta }> {
  const res = await apiPost<{ data: HealthProfile; meta?: ProfileWriteMeta }>('/me/profile', patch, {
    bearer: requireToken(),
    method: 'PUT',
    fetchImpl,
  });
  return { profile: res.data, meta: res.meta ?? {} };
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
 * ⚠️ Tri-state, and there is no fourth "unknown" value to pass.
 *
 * Omitting `--smoking` leaves the field alone, which is UNKNOWN. There is
 * deliberately no way to spell "prefer not to say": not answering is already
 * that, and offering it as a settable value invites writing it where `never`
 * was meant. `former` is a distinct value because CARET randomised former
 * smokers and found the same harm.
 */
const SMOKING = ['never', 'former', 'current'];

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
  if (opts.smoking !== undefined) {
    if (!SMOKING.includes(opts.smoking as string))
      return { patch, error: `--smoking must be one of: ${SMOKING.join(', ')}.` };
    patch.smokingStatus = opts.smoking as string;
  }
  if (opts.tracksBloodwork !== undefined) patch.tracksBloodwork = Boolean(opts.tracksBloodwork);
  // Owner ruling 192.3. Culprits only, and it REPLACES the stored list, so any
  // product, reaction or timing details recorded on the website are dropped.
  // `none` clears. Use the website or the API for the full record.
  if (typeof opts.enzymeAllergy === 'string') {
    const list = csv(opts.enzymeAllergy);
    if (list.length === 1 && list[0] === 'none') {
      patch.enzymeAllergies = [];
    } else {
      const bad = list.filter((c) => !(ENZYME_CULPRITS as readonly string[]).includes(c));
      if (bad.length || list.length === 0)
        return {
          patch,
          error: `--enzyme-allergy must be a comma list of: ${ENZYME_CULPRITS.join(', ')} (or none to clear).`,
        };
      patch.enzymeAllergies = list.map((c) => ({ culprit: c as EnzymeAllergyRecord['culprit'] }));
    }
  }
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
  // Displayed for every profile, not just when set — a reader checking why
  // beta-carotene is being withheld (or not) needs to see what we think we know.
  row('Smoking', p.smokingStatus);
  if (p.enzymeAllergiesAvailable === false) {
    row('Enzyme allergy', 'record could not be read (the condition caution still applies)');
  } else if (p.enzymeAllergies?.length) {
    const enzymes = p.enzymeAllergies.filter((r) => r.kind !== 'product');
    const products = p.enzymeAllergies.filter((r) => r.kind === 'product');
    if (enzymes.length) {
      row(
        'Enzyme allergy',
        enzymes.map((r) => (r.product ? `${r.culprit} (${r.product})` : r.culprit)).join(', '),
      );
    }
    // Pharmacist ruling 216: a reaction to any product.
    if (products.length) {
      row(
        'Product reaction',
        products
          .map((r) => {
            const name = [r.productSlug, r.product, r.manufacturer].filter(Boolean).join(' / ') || 'unnamed';
            // Ruling 226, call 4: individually reviewed other products, each with its plan.
            const reviewed = (r.reviewedDistinctProducts ?? []).map(
              (d) =>
                `reviewed: ${d.product} (${d.manufacturer}), ${d.documentedBy} ${d.documentedOn}, plan: ${d.plan}`,
            );
            return reviewed.length ? `${name} [${reviewed.join('; ')}]` : name;
          })
          .join(', '),
      );
    }
  }
  // Pharmacist ruling 216: vitamin E and niacin regimens.
  if (p.doseFormRecordsAvailable === false) {
    row(
      'Vitamin E / niacin',
      'records could not be read (an unknown regimen keeps the optional suggestion withheld)',
    );
  } else if (p.doseFormRecords?.length) {
    row(
      'Vitamin E / niacin',
      p.doseFormRecords
        .map((r) =>
          [
            r.nutrient,
            r.product,
            r.form,
            r.amountPerDose ? `${r.amountPerDose} ${r.unit ?? ''}`.trim() : null,
            r.frequency,
            r.basis,
            // Ruling 226: what the record describes, so an unlinked one is visible.
            r.stackSlug
              ? `for ${r.stackSlug} in the stack`
              : r.medication
                ? `for ${r.medication}`
                : 'not linked',
            r.review ? (reviewCoversRegimen(r) ? 'reviewed' : 'review lapsed') : null,
            r.currentUse === 'not-current'
              ? `not currently taken${r.notCurrentSince ? ` since ${r.notCurrentSince}` : ''}`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
        )
        .join(' | '),
    );
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
  const { profile, meta } = await getProfileWithMeta();
  if (asJson) {
    out(JSON.stringify({ profile, ...(clarificationLines(meta).length ? { meta } : {}) }, null, 2));
    return;
  }
  if (!profile) {
    out(dim('No profile set yet.') + ' Set one with `supstack profile set --age 30 --sex male --weight 75`.');
    return;
  }
  renderProfile(profile);
  for (const line of clarificationLines(meta)) out(line);
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
  const { profile, meta } = await setProfileWithMeta(patch);
  if (asJson) {
    out(
      JSON.stringify(
        {
          profile,
          ...(clarificationLines(meta).length
            ? {
                meta: {
                  conditionsNeedingClarification: meta.conditionsNeedingClarification,
                  conditionClarificationNote: meta.conditionClarificationNote,
                },
              }
            : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  out(dim('Profile updated.'));
  renderProfile(profile);
  // Ruling 417 (E-38): her text, verbatim, for each stored combined answer.
  for (const line of clarificationLines(meta)) out(line);
}

/** `supstack profile clear` — delete the health profile. */
export async function runProfileClear(): Promise<void> {
  await clearProfile();
  out('Profile cleared.');
}
