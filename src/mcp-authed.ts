import { z } from 'zod';

import {
  ABANDON_BEFORE_654,
  abandonExperiment,
  checkInExperiment,
  getExperiment,
  getExperimentProtocol,
  getExperiments,
  postCorrection,
  postRestart,
  postSafetyReport,
  startExperiment,
} from './experiments';
import { ENZYME_CULPRITS, getProfileWithMeta, setProfileWithMeta, withReviewFingerprints } from './profile';
import { getRecommendations } from './recommend';
import { getAdherence, logIntake } from './track';

/**
 * Authenticated MCP tools — the account-scoped operations (recommend, profile,
 * experiments, adherence) exposed to agents. Kept SEPARATE from the read-only
 * capability registry because they require the user to be signed in: each handler
 * calls a function that reads the stored account token (`supstack login`, or
 * SUPSTACK_TOKEN) and throws `NotLoggedInError` if absent. The MCP layer surfaces
 * that as a normal tool error, so an agent gets a clear "run supstack login"
 * message rather than a crash.
 *
 * (Cloud-stack pull/push/sync is already reachable via the `supstack_stack` tool,
 * whose handler is token-aware — so it is intentionally not duplicated here.)
 */
export interface AuthedTool {
  name: string;
  /** Written for an LLM reader — states what it does AND that login is required. */
  description: string;
  schema: z.ZodTypeAny;
  /** True if the tool changes account state (drives the MCP readOnlyHint). */
  mutates?: boolean;
  handler: (input: unknown) => Promise<unknown>;
}

/** Identity helper that keeps each handler typed against its own schema. */
function tool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  schema: S;
  mutates?: boolean;
  handler: (input: z.infer<S>) => Promise<unknown>;
}): AuthedTool {
  return { ...def, handler: (input) => def.handler(input as z.infer<S>) };
}

/** Ruling 281 call 3: `confirmed` sits beside the old three. */
const DECISIONS = ['excluded', 'confirmed', 'suspected-or-unresolved', 'not-discussed'] as const;

/**
 * Pharmacist rulings 354 to 356 (approved 9 October 2026), for every MCP tool
 * that takes a restart record, as the API, the web form and the assistant apply them.
 */
const RESTART_RULING_354_356 =
  'Pharmacist ruling 354 (option 3): only seriousInjury "excluded" (the clinician explicitly ruled out a serious reaction to this product) may go on to the other restart checks. confirmed, suspected-or-unresolved, not-discussed, missing or unknown are held whatever clearance is recorded, refused with 409 product_reaction_held: relay its message first, and never invite the user to change a real event into a mistake. A clearance reference never means the clinician ruled it out. Ruling 355: seriousIllness not-discussed is held until the clinician assesses it. confirmed needs eventResolution resolved or stable as the clinician assessed it, plus clearanceReference (documented advice for this exact product). suspected-or-unresolved needs all of that and illnessAssessmentComplete true, only if the user says the clinician completed a safety assessment and documented that this exact product may be restarted despite the uncertain diagnosis.';

/** Ruling 280: the dedicated plan's typed fields, the same as the API's PopulationPlan. */
const PLAN_REGIMEN = z.object({
  product: z.string(),
  ingredients: z.string(),
  chemicalForm: z.string(),
  route: z.enum([
    'oral',
    'sublingual',
    'topical',
    'nasal',
    'inhaled',
    'vaginal',
    'rectal',
    'injection',
    'other',
  ]),
  amount: z.number().positive(),
  unit: z.enum(['mg', 'mcg', 'g', 'IU', 'ml']),
  basis: z.enum(['per-dose', 'daily-total']),
  measure: z.enum(['ingredient-equivalent', 'compound-mass', 'unknown']),
  release: z.enum(['immediate', 'modified', 'unknown']),
  timesPer: z.number().int().min(1).max(24),
  period: z.enum(['day', 'week']),
  schedule: z.string(),
});
const LACTATION_CONTEXT = z.object({
  children: z
    .array(
      z.object({
        ageMonths: z.number().int().min(0).max(120),
        premature: z.enum(['yes', 'no', 'not-known']),
        health: z.string(),
      }),
    )
    .min(1)
    .max(8),
  feedingPattern: z.string(),
  breastMilkShare: z.enum(['all', 'most', 'about-half', 'some', 'occasional']),
});
const POPULATION_PLAN = z.object({
  kind: z.enum(['pregnancy', 'lactation']),
  coversBoth: z.boolean(),
  regimen: PLAN_REGIMEN,
  lactation: LACTATION_CONTEXT.optional(),
  reviewerRole: z.enum(['doctor', 'pharmacist', 'nurse', 'midwife', 'other-clinician']),
  reviewedOn: z.string(),
  advice: z.enum(['use', 'restart', 'do-not-use']),
  adviceText: z.string(),
  monitoring: z.string(),
  reassessWhen: z.string(),
  maternalHealth: z.string(),
  concurrentProducts: z.string(),
  documentedAt: z.string().optional(),
  patientReported: z.boolean(),
});

const EXERCISE = ['none', '1-2', '3-4', '5+'] as const;
const DIET = ['omnivore', 'vegetarian', 'vegan', 'keto', 'paleo', 'mediterranean', 'other'] as const;
const STRESS = ['low', 'moderate', 'high', 'very-high'] as const;
const BLOCK = ['morning', 'breakfast', 'midday', 'dinner', 'bedtime'] as const;

/**
 * Pharmacist ruling 412 (10 October 2026): "Carry the full applicable
 * eligibility rule in all refusal responses and display it to the reader ...
 * A field is useful only if it survives client formatting and tool
 * summarisation." The refusal JSON reaches the model whole (formatToolError);
 * this tells it to show the rule.
 */
const ELIGIBILITY_RELAY_412 =
  " A refusal that carries `eligibility` (the pharmacist's complete rule: the pre-start form on a start, the restart form on a restart) must be shown to the user word for word, after the refusal's `message`. Never summarise it. A refusal with `app_restart_unavailable` or `permanently_excluded` is not released by any record: relay its `message` word for word.";
const REQUIRES_LOGIN = ' Requires the user to be signed in (`supstack login`).';

export const AUTHED_TOOLS: AuthedTool[] = [
  tool({
    name: 'supstack_recommend',
    description:
      "Personalized supplement recommendations computed from the signed-in user's saved goals and cloud stack, each with a composite score, evidence, the best-matching goal, and any safety warnings. When `meta.teenNotice` is set, relay it: the user is under 18 and most entries were withheld because they are not assessed for that age. When `meta.coverageNotice` or `meta.medicineNotices` is set, relay each once: they are about the user's medicines (a medicine we could not check, or a precaution about the medicine itself), not about any one recommendation. When `meta.heldForRegimen` has entries, relay each `notice` with its `url`: the entry (red yeast rice or vitamin E) is held back until the user records a product's dose and form in their profile, and it never means they should start, stop or change anything." +
      REQUIRES_LOGIN,
    schema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    handler: (input) => getRecommendations(input.limit),
  }),
  tool({
    name: 'supstack_profile_get',
    description:
      "Read the signed-in user's health profile (age, biological sex, weight, conditions, medications, goals, lifestyle). Returns null if no profile has been set. If it returns conditionClarificationNote, show it to the user word for word." +
      REQUIRES_LOGIN,
    schema: z.object({}),
    // Ruling 417 (E-38): the server's clarification report rides on the result.
    handler: async () => {
      const { profile, meta } = await getProfileWithMeta();
      return profile && meta.conditionsNeedingClarification?.length
        ? {
            ...profile,
            conditionsNeedingClarification: meta.conditionsNeedingClarification,
            conditionClarificationNote: meta.conditionClarificationNote,
          }
        : profile;
    },
  }),
  tool({
    name: 'supstack_profile_set',
    description:
      "Update fields on the signed-in user's health profile. Only the fields you pass are changed; omit the rest. Returns the full updated profile." +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z
      .object({
        age: z.number().int().min(13).max(120).optional(),
        biologicalSex: z.enum(['male', 'female']).optional(),
        weight: z.number().positive().max(1000).optional(),
        weightUnit: z.enum(['kg', 'lbs']).optional(),
        healthConditions: z.array(z.string()).optional(),
        medications: z.array(z.string()).optional(),
        primaryGoals: z.array(z.string()).optional(),
        currentSupplements: z.array(z.string()).optional(),
        sleepHours: z.number().min(0).max(24).optional(),
        exerciseFrequency: z.enum(EXERCISE).optional(),
        dietType: z.enum(DIET).optional(),
        stressLevel: z.enum(STRESS).optional(),
        tracksBloodwork: z.boolean().optional(),
        // Owner ruling 192.3 and pharmacist ruling 200. Replaces the stored
        // list. A known culprit, reported or confirmed, blocks the products
        // listed with it; 'unknown' keeps a caution plus clinician or allergist
        // assessment advice. Never suggest a home test.
        enzymeAllergies: z
          .array(
            z.object({
              // Pharmacist ruling 216: "product" records a reaction to any
              // product (send culprit "unknown"); its productSlug is never
              // suggested automatically and each allergen is a declared allergy.
              kind: z.enum(['enzyme', 'product']).nullish(),
              composition: z.string().max(300).nullish(),
              allergens: z.array(z.string().max(60)).max(30).nullish(),
              // Ruling 226, call 4: other products of the entry a clinician or
              // allergist reviewed individually, each with its own plan. Only
              // what the reader reports. The culprit itself is refused.
              reviewedDistinctProducts: z
                .array(
                  z.object({
                    product: z.string().max(300),
                    manufacturer: z.string().max(300),
                    labelVersionOrLot: z.string().max(300).nullish(),
                    documentedBy: z.string().max(300),
                    documentedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                    plan: z.string().max(300),
                    reference: z.string().max(300).nullish(),
                  }),
                )
                .max(5)
                .nullish(),
              culprit: z.enum(ENZYME_CULPRITS),
              product: z.string().max(300).nullish(),
              productSlug: z.string().max(80).nullish(),
              // Pharmacist ruling 200: provenance, attribution and the clinician outcome.
              manufacturer: z.string().max(300).nullish(),
              formulation: z.string().max(300).nullish(),
              labelVersionOrLot: z.string().max(300).nullish(),
              dose: z.string().max(300).nullish(),
              route: z.enum(['oral', 'topical', 'other', 'unknown']).nullish(),
              source: z.string().max(300).nullish(),
              reaction: z.string().max(300).nullish(),
              timing: z.enum(['minutes', 'hours', 'later', 'unknown']).nullish(),
              professionallyConfirmed: z.boolean().nullish(),
              attribution: z.enum(['assessed-culprit', 'uncertain']).nullish(),
              avoidanceScope: z.enum(['enzyme', 'product-or-source']).nullish(),
              clinicianReview: z
                .object({
                  outcome: z.enum(['alternative-explanation', 'delabelled']),
                  documentedBy: z.string().max(300),
                  documentedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  reference: z.string().max(300).nullish(),
                })
                .nullish(),
            }),
          )
          .max(10)
          .optional(),
        // Pharmacist ruling 216. Replaces the stored list. The vitamin E and
        // niacin products the reader takes, as they state them from the actual
        // product. Never derive `basis` from a number: ask the reader. An
        // incomplete record keeps the optional suggestion withheld, and nothing
        // here tells the reader to stop prescribed treatment.
        doseFormRecords: z
          .array(
            z.object({
              nutrient: z.enum(['vitamin-e', 'niacin']),
              product: z.string().max(300).nullish(),
              form: z
                .enum([
                  'natural-alpha-tocopherol',
                  'synthetic-alpha-tocopherol',
                  'mixed-tocopherols',
                  'tocotrienols',
                  'water-soluble-tpgs',
                  'in-a-multivitamin-or-blend',
                  'nicotinic-acid',
                  'nicotinamide',
                  'inositol-hexanicotinate',
                  'in-a-multivitamin-or-b-complex',
                  'other',
                  'unknown',
                ])
                .nullish(),
              release: z.enum(['immediate', 'extended', 'unknown']).nullish(),
              amountPerDose: z.number().positive().nullish(),
              unit: z.enum(['mg', 'IU', 'unknown']).nullish(),
              frequency: z.string().max(300).nullish(),
              indication: z.string().max(300).nullish(),
              basis: z.enum(['nutritional', 'higher-dose', 'clinician-managed', 'unknown']).nullish(),
              otherProducts: z.string().max(300).nullish(),
              anticoagulant: z.boolean().nullish(),
              bleedingHistory: z.boolean().nullish(),
              clinicianPlan: z.string().max(300).nullish(),
              review: z
                .object({
                  documentedBy: z.string().max(300),
                  documentedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  reference: z.string().max(300).nullish(),
                  // Ruling 226: stamped by the handler with the regimen sent beside it when absent.
                  regimenFingerprint: z.string().max(300).nullish(),
                })
                .nullish(),
              // Ruling 226, call 3: the product this record describes. One
              // record never covers another product: link each to its own.
              stackSlug: z.string().max(80).nullish(),
              stackItemId: z.string().max(300).nullish(),
              stackItemVersion: z.string().max(300).nullish(),
              medication: z.string().max(300).nullish(),
              // Ruling 266 row 13: the stack row's product fingerprint when recorded.
              stackItemProduct: z.string().max(300).nullish(),
              // Rulings 266 row 11 and 273: a stopped product is marked not
              // currently taken and kept as history, never deleted to resolve it.
              currentUse: z.enum(['not-current']).nullish(),
              notCurrentSince: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .nullish(),
            }),
          )
          .max(10)
          .optional(),
      })
      .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' }),
    // ⚠️ Round 149. Returns the server's `unrecognisedConditions` alongside the
    // saved profile. A MODEL sets the profile here on someone's behalf and
    // reports back; a dropped caveat becomes a confident summary.
    handler: async (input) => {
      // Ruling 226: a review covers exactly the regimen it is sent with.
      const patch = input.doseFormRecords
        ? { ...input, doseFormRecords: withReviewFingerprints(input.doseFormRecords) }
        : input;
      const { profile, meta } = await setProfileWithMeta(patch);
      // Ruling 417 (E-38): the clarification report rides on the result too.
      const clarification = meta.conditionsNeedingClarification?.length
        ? {
            conditionsNeedingClarification: meta.conditionsNeedingClarification,
            conditionClarificationNote: meta.conditionClarificationNote,
          }
        : {};
      return meta.unrecognisedConditions?.length
        ? {
            ...profile,
            ...clarification,
            unrecognisedConditions: meta.unrecognisedConditions,
            unrecognisedConditionsNote:
              'These were saved but cannot be interpreted, so nothing downstream checks them — no contraindication, no population verdict, no interaction warning. Silence about them is not a clean bill of health.',
          }
        : Object.keys(clarification).length
          ? { ...profile, ...clarification }
          : profile;
    },
  }),
  tool({
    name: 'supstack_experiments_list',
    description:
      "List the signed-in user's N-of-1 experiments (supplement × goal, status, check-in progress, verdict). Optionally filter by status. Owner call O-6: a paused row with `held: true` is one whose restart the app refuses whatever record is sent (`heldReason.error` is the code); get it with supstack_experiments_get for the text to relay." +
      REQUIRES_LOGIN,
    schema: z.object({
      status: z.enum(['baseline', 'active', 'completed', 'abandoned']).optional(),
    }),
    handler: (input) => getExperiments(input.status),
  }),
  tool({
    name: 'supstack_experiments_get',
    description:
      "Get one of the signed-in user's experiments in full (protocol, verdict + summary, and check-in responses) by its id. When `safetyAction` is set, relay its `instruction` first. A paused experiment with a pausing `safetyAction` restarts only on the restart record its `restartRequires` names (a clinician who advised the restart, a documented clearance for a serious event, or an agreed timing schedule), entered with supstack_experiment_restart (or on the web dashboard or with the SupStack assistant, `restartRoute`). An answer chosen by mistake is corrected with supstack_experiment_correct (`correctionRoute`). When `statusHold` is set, the next dose is held until an answer is clear: relay `updateAnswer.how`, and when `updateAnswer.chosenAnswers` is set, tell the user which answer they chose and when it was saved (`chosenAt`, or that the date is unknown when it is null), and relay `updateAnswer.confirmNow`: the saved answer is not a current one, so ask what is happening now (it was chosen in a check-in that was not submitted, perhaps on another device). Relay `medicineConflict` when present. Relay `note` too: the pause is of the optional supplement experiment only. Owner call O-6: when `held` is true, the app refuses its restart whatever record is sent (`heldRefusal.error`: permanently_excluded or app_restart_unavailable): relay `heldRefusal` first, word for word (`heldRefusal.refusal`: `urgentLead` as the heading, then each of `actions` and `hold`, or `heldRefusal.message` when there is no `refusal`, then `heldRefusal.footer`), and do not ask for a restart record." +
      REQUIRES_LOGIN,
    schema: z.object({ id: z.string().min(1) }),
    handler: (input) => getExperiment(input.id),
  }),
  tool({
    name: 'supstack_track_log',
    description:
      "Log a supplement dose for the signed-in user. Omit `supplement` to log the user's whole stack for the day. Defaults to today / taken. Relay any `warnings`, `coverageNotice` and `medicineNotices` in the result: the last two are about the user's medicines and are said once. Relay `experimentHolds` too (pharmacist ruling 279): an experiment of that supplement holds the next optional dose, and its `message` says which answer to update and how; never tell the user to stop prescribed medicine." +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z.object({
      supplement: z.string().optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
        .optional(),
      status: z.enum(['taken', 'skipped']).default('taken'),
      block: z.enum(BLOCK).optional(),
    }),
    handler: (input) => logIntake(input),
  }),
  tool({
    name: 'supstack_track_adherence',
    description:
      "The signed-in user's adherence rate, current streak, and per-supplement breakdown over the last N days (default 30)." +
      REQUIRES_LOGIN,
    schema: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    handler: (input) => getAdherence(input.days),
  }),
  tool({
    name: 'supstack_experiment_protocol',
    description:
      'Preview the N-of-1 protocol for a supplement × goal WITHOUT starting it: the dosing, schedule, and the baseline + check-in questions (with their ids, types, and options). Call this first so you know which questions to answer before `supstack_experiment_start`. Supplement is a slug, goal is a goal id (see supstack_goals).' +
      REQUIRES_LOGIN,
    schema: z.object({ supplement: z.string().min(1), goal: z.string().min(1) }),
    handler: (input) => getExperimentProtocol(input.supplement, input.goal),
  }),
  tool({
    name: 'supstack_experiment_start',
    description:
      "Start an N-of-1 experiment for the signed-in user. `answers` maps baseline question ids (from supstack_experiment_protocol) to the user's answers. If required baseline answers are missing, returns a 400 listing them — gather those and retry. If an earlier experiment with this supplement ended while paused for safety, returns a 409 `prior_safety_pause` with `restartRequires`: relay its message, ask the user in their own words for the restart record (reviewerRole, reviewedOn YYYY-MM-DD, dose, productForm, restartPlan, clinicianAdvisedRestart true only if a clinician ADVISED it, seriousInjury, seriousIllness, eventResolution, illnessAssessmentComplete, otherExposures, and clearanceReference for documented-clearance) and retry with `restartRecord`. On a successful start, when `safety` is set, relay each of `safety.risks` word for word, and when `safety.uncheckedAxes` is set, say those were not checked: an `unavailable` level means the experiment was not safety-screened at all. " +
      RESTART_RULING_354_356 +
      "  Never fill it in for them. Owner call O-5: a 409 `population_blocked` means the user's health profile (with the baseline allergy history for bee pollen and royal jelly) blocks this product, for every product: nothing was created. Relay its `message`, then `footer` and `eligibility`, word for word. Returns the created experiment with its first check-in date." +
      ELIGIBILITY_RELAY_412 +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z.object({
      supplement: z.string().min(1),
      goal: z.string().min(1),
      answers: z.record(z.string(), z.unknown()).default({}),
      restartRecord: z
        .object({
          reviewerRole: z.enum(['doctor', 'pharmacist', 'nurse', 'midwife', 'other-clinician']),
          // The API reads `reviewedOn`. This schema said `documentedOn`, which the API never read, so no
          // MCP prior-pause record could ever be complete (fail-closed, but unusable). Fixed with rulings 354 to 356.
          reviewedOn: z.string(),
          dose: z.string(),
          productForm: z.string().optional(),
          restartPlan: z.string(),
          clinicianAdvisedRestart: z.boolean(),
          clearanceReference: z.string().optional(),
          seriousInjury: z.enum(DECISIONS).optional(),
          seriousIllness: z.enum(DECISIONS).optional(),
          eventResolution: z.enum(['resolved', 'stable', 'not-resolved']).optional(),
          illnessAssessmentComplete: z.boolean().optional(),
          otherExposures: z.string().optional(),
          sjsTen: z.enum(['confirmed-culprit', 'ruled-out', 'suspected', 'not-assessed']).optional(),
        })
        .optional(),
    }),
    handler: (input) =>
      startExperiment(input.supplement, input.goal, input.answers, undefined, [], input.restartRecord),
  }),
  tool({
    name: 'supstack_experiment_check_in',
    description:
      'Submit a check-in for one of the signed-in user\'s experiments. `answers` maps the experiment\'s check-in question ids to the user\'s answers (get the questions from supstack_experiments_get → protocol.checkIn.questions, or supstack_experiment_protocol). On the FINAL check-in the verdict is computed and returned. The check-in number is derived server-side. Every question with category "safety" must be answered (the server returns 400 listing any that are missing): ask the user each one, and if they are not sure, send "not-sure" (valid for yes/no, choice and multi safety questions). Never answer a safety question for the user. When the result carries `safetyAction`, relay its `instruction` to the user FIRST, word for word, before anything else. If `safetyAction.pauses` is true the experiment is paused: do not suggest the next dose or the next check-in, and do not tell the user to stop prescribed medicines. When the result carries `safety`, relay each of `safety.risks` after the instruction.' +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z.object({ id: z.string().min(1), answers: z.record(z.string(), z.unknown()).default({}) }),
    handler: (input) => checkInExperiment(input.id, input.answers),
  }),
  tool({
    name: 'supstack_experiment_report_safety',
    description:
      'Pharmacist rulings 601, 704 and 705: "Report a symptom or safety concern" for one of the signed-in user\'s running, paused or ended (completed or abandoned: it stays ended) experiments, at any time, outside the check-in schedule (POST /me/experiments/:id/safety-report). Offer it whenever the user mentions a symptom, a reaction, a warning sign or a pregnancy or breastfeeding change during an experiment, without waiting for the next check-in. First relay `safetyReport.emergencyLine` from supstack_experiments_get word for word. `answers` maps `safetyReport.questions` ids to the user\'s answers: every one is required, "not-sure" is an answer. Never answer for the user. The result carries `safetyAction` exactly as a check-in does: relay its heading and instruction FIRST, word for word. If `paused` is true the experiment is paused: do not suggest the next dose or a check-in, and do not tell the user to stop prescribed medicines. A report never counts as a check-in and never moves the schedule. To clarify ONE earlier saved answer (`safetyReport.savedAnswers`, her W705 text in `safetyReport.clarify`), pass `clarifies` { reportNumber, questionId, kind: situation-changed (default) or entered-by-mistake } and answer only that question (and its follow-ups): the report names the answer it clarifies, resolves only that answer\'s status hold and only with a definite answer, and never lifts a pausing answer (`clarification.restrictionKept`). A mistaken answer that PAUSED the experiment is corrected with supstack_experiment_correct and `reportNumber` (her W706 text in `safetyReport.correct`). Relay the `saved` text as sent.' +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z.object({
      id: z.string().min(1),
      answers: z.record(z.string(), z.unknown()).default({}),
      clarifies: z
        .object({
          reportNumber: z.number().int().min(1),
          questionId: z.string().min(1),
          kind: z.enum(['situation-changed', 'entered-by-mistake']).optional(),
        })
        .optional(),
    }),
    handler: (input) => postSafetyReport(input.id, input.answers, input.clarifies),
  }),
  tool({
    name: 'supstack_experiment_correct',
    description:
      'Correct one of the signed-in user\'s experiment answers without a clinician record (POST /me/experiments/:id/correction). Three uses. (1) A STATUS hold (`statusHold` on supstack_experiments_get, an uncertain pregnancy or breastfeeding status or a follow-up not answered): pass only `renewedScreen` with the answers to `updateAnswer.questions`; a definite answer releases only that hold. (2) A check-in answer chosen BY MISTAKE (nothing happened, nothing is happening now), after the check-in was submitted (`checkInNumber` = progress.completed) or before (`checkInNumber` = the check-in being answered, when the pause came from an answer chosen and not submitted): pass `checkInNumber`, `correctedAnswers` for ONLY the answer(s) the user says were chosen by mistake (pharmacist ruling 281 call 2: another answer or open event that still holds the pause keeps it, and the correction is still recorded: a 200 with `released: false` means the experiment stays paused, relay `note`), optionally `eventIds` for the open events they identified, `renewedScreen` (the warning signs, the pregnancy and breastfeeding status) and `affirmedNoEvent: true` only if the user affirms: "I chose this answer by mistake. None of these symptoms or events happened, and I have none of them now. This corrects my answer. It is not a clinical review." (3) Pharmacist ruling 706: an answer SAVED in a safety report entered BY MISTAKE: pass `reportNumber` (not `checkInNumber`) with `correctedAnswers`, `renewedScreen` and `affirmedNoEvent`, on a paused or an ended experiment: the same audited correction, scoped to that report\'s own answers and events, with the old and new values, reason, time, channel and resulting state recorded; relay `released` and `remainingHolds`. A real or uncertain symptom is NOT a mistake: use supstack_experiment_restart with the restart record instead. A refusal (409) carries the instruction in `safetyAction`: relay it first, word for word. Never answer for the user. A correction is a data correction, never a clinical review.' +
      " Pharmacist ruling 410: a 409 `finish_check_in` carries the open check-in's saved answer in `pendingAnswer`, with its `heading` and `instruction` (the event's own action and next-dose guidance): relay that instruction first, word for word, then `message`." +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z.object({
      id: z.string().min(1),
      renewedScreen: z.record(z.string(), z.string()).default({}),
      checkInNumber: z.number().int().min(1).optional(),
      correctedAnswers: z.record(z.string(), z.string()).optional(),
      affirmedNoEvent: z.boolean().optional(),
      eventIds: z.array(z.string()).optional(),
      reportNumber: z.number().int().min(1).optional(),
    }),
    handler: (input) =>
      postCorrection(input.id, {
        renewedScreen: input.renewedScreen,
        ...(input.reportNumber !== undefined ? { reportNumber: input.reportNumber } : {}),
        ...(input.checkInNumber !== undefined ? { checkInNumber: input.checkInNumber } : {}),
        ...(input.correctedAnswers ? { correctedAnswers: input.correctedAnswers } : {}),
        ...(input.affirmedNoEvent !== undefined ? { affirmedNoEvent: input.affirmedNoEvent } : {}),
        ...(input.eventIds?.length ? { eventIds: input.eventIds } : {}),
      }),
  }),
  tool({
    name: 'supstack_experiment_restart',
    description:
      'Restart one of the signed-in user\'s experiments that a safety answer paused (POST /me/experiments/:id/restart), with the restart record: the user\'s own account, never filled in for them. First ask the screen again (`renewedScreen`: the check-in safety questions, the warning signs and the pregnancy and breastfeeding status, from supstack_experiments_get → checkInQuestions); an answer there that needs help stops the restart with `safetyAction`: relay it first, word for word. Then `restartRecord`, in their words: reviewerRole (doctor, pharmacist, nurse, midwife, other-clinician), reviewedOn YYYY-MM-DD, dose, productForm, restartPlan, clinicianAdvisedRestart true ONLY if a clinician ADVISED they can restart this product in this form and at this dose (having contacted one is not enough), seriousInjury and seriousIllness (each excluded, confirmed, suspected-or-unresolved or not-discussed, never a false "excluded"), eventResolution (resolved, stable, not-resolved, as the clinician assessed it), illnessAssessmentComplete (only for a suspected illness). ' +
      RESTART_RULING_354_356 +
      ELIGIBILITY_RELAY_412 +
      ' Also otherExposures (or "none"), clearanceReference for a documented clearance, and maternityAssessed with pregnancyPlan for a maternity event. Pharmacist ruling 281 call 1: when the pause names more than one illness (`restartMustRecordExcluded`), ask about EACH one and pass `seriousIllnessBy` ({ illness: decision }); a single `seriousIllness` is acceptable only after you showed the user the complete named list and they confirmed it applies to all of it (`seriousIllnessAppliesToAll: true`). Missing or unknown never counts as ruled out. Ruling 293/T3 (K28): a pause naming a serious skin reaction needs `sjsTen`, asked as "What did the clinician conclude about this product and Stevens–Johnson syndrome or toxic epidermal necrolysis?" with exactly four answers: confirmed-culprit (never restarted, the product is excluded for good), ruled-out (specifically assessed and ruled out: the only one that restarts), suspected (still suspected or assessment unfinished) or not-assessed (not assessed or unsure). suspected and not-assessed stay excluded pending specialist assessment (409 sjs_ten_assessment_pending): no clearance overrides them. "They did not confirm it" is not ruled-out: ask again. Ruling 280: when the user is pregnant or breastfeeding and `populationPlansRequired` is set, either pass `currentRegimen` (and `currentLactation` when breastfeeding) to compare with the plan on record, or record the plan in `populationPlans` (the exact product, ingredients, chemical form, route, amount as a number with unit mg/mcg/g/IU/ml, per-dose or daily-total, ingredient-equivalent or compound-mass, release, timesPer per day or week, schedule; for breastfeeding every child\'s age in months, prematurity and health, the feeding pattern and breast-milk share; reviewer, date, advice use/restart/do-not-use with their words, monitoring, reasons to reassess, maternal health, concurrent products, documentedAt for an avoid product; coversBoth only when one consultation covered both). Never tell them to stop breastfeeding or prescribed medicine. A 409 `restart_record_incomplete` or `population_plan_required` lists `restartRecordProblems`: ask for exactly those. A 409 `status_hold` with `heldExperiment`: another experiment\'s answer holds every restart, relay its message. A status hold is not restarted here: use supstack_experiment_correct. The pause is of the optional supplement experiment only, never of prescribed medicine.' +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z.object({
      id: z.string().min(1),
      renewedScreen: z.record(z.string(), z.string()).default({}),
      restartRecord: z.object({
        reviewerRole: z.enum(['doctor', 'pharmacist', 'nurse', 'midwife', 'other-clinician']),
        reviewedOn: z.string(),
        dose: z.string(),
        productForm: z.string().optional(),
        restartPlan: z.string(),
        clinicianAdvisedRestart: z.boolean(),
        seriousInjury: z.enum(DECISIONS).optional(),
        seriousIllness: z.enum(DECISIONS).optional(),
        seriousIllnessBy: z.record(z.string(), z.enum(DECISIONS)).optional(),
        seriousIllnessAppliesToAll: z.boolean().optional(),
        // Ruling 293/T3 and K28: four answers. suspected and not-assessed stay excluded pending specialist assessment.
        sjsTen: z.enum(['confirmed-culprit', 'ruled-out', 'suspected', 'not-assessed']).optional(),
        eventResolution: z.enum(['resolved', 'stable', 'not-resolved']).optional(),
        // Rulings 355 and 356: only for a suspected illness, true only when the user said yes.
        illnessAssessmentComplete: z.boolean().optional(),
        otherExposures: z.string().optional(),
        clearanceReference: z.string().optional(),
        maternityAssessed: z.boolean().optional(),
        pregnancyPlan: z.string().optional(),
        populationPlans: z.array(POPULATION_PLAN).optional(),
        currentRegimen: PLAN_REGIMEN.optional(),
        currentLactation: LACTATION_CONTEXT.optional(),
      }),
    }),
    handler: (input) =>
      postRestart(input.id, { renewedScreen: input.renewedScreen, restartRecord: input.restartRecord }),
  }),
  tool({
    name: 'supstack_experiment_abandon',
    description:
      "Stop one of the signed-in user's in-progress experiments (sets it to 'abandoned' — no verdict). A completed or already-abandoned experiment is rejected. Without confirm: true it changes nothing and returns the effect of ending (her W654): show it to the user word for word, then call again with confirm: true once they ask to end it." +
      REQUIRES_LOGIN,
    mutates: true,
    schema: z.object({
      id: z.string().min(1),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Ruling 654: true only after the user has been shown the effect of ending (the text this tool returns without it) and asked to end it',
        ),
    }),
    // Ruling 654 (22 October 2026): her W654 before an uninformed abandon. Nothing changes without `confirm: true`.
    handler: async (input) =>
      input.confirm === true
        ? abandonExperiment(input.id)
        : {
            abandoned: false,
            confirmationRequired: true,
            message: ABANDON_BEFORE_654,
            confirmWith: { confirm: true },
          },
  }),
];
