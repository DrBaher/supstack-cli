import { z } from 'zod';

import { getExperiment, getExperiments } from './experiments';
import { getProfile, setProfile } from './profile';
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

const EXERCISE = ['none', '1-2', '3-4', '5+'] as const;
const DIET = ['omnivore', 'vegetarian', 'vegan', 'keto', 'paleo', 'mediterranean', 'other'] as const;
const STRESS = ['low', 'moderate', 'high', 'very-high'] as const;
const BLOCK = ['morning', 'breakfast', 'midday', 'dinner', 'bedtime'] as const;

const REQUIRES_LOGIN = ' Requires the user to be signed in (`supstack login`).';

export const AUTHED_TOOLS: AuthedTool[] = [
  tool({
    name: 'supstack_recommend',
    description:
      "Personalized supplement recommendations computed from the signed-in user's saved goals and cloud stack, each with a composite score, evidence, the best-matching goal, and any safety warnings." +
      REQUIRES_LOGIN,
    schema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    handler: (input) => getRecommendations(input.limit),
  }),
  tool({
    name: 'supstack_profile_get',
    description:
      "Read the signed-in user's health profile (age, biological sex, weight, conditions, medications, goals, lifestyle). Returns null if no profile has been set." +
      REQUIRES_LOGIN,
    schema: z.object({}),
    handler: () => getProfile(),
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
      })
      .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' }),
    handler: (input) => setProfile(input),
  }),
  tool({
    name: 'supstack_experiments_list',
    description:
      "List the signed-in user's N-of-1 experiments (supplement × goal, status, check-in progress, verdict). Optionally filter by status." +
      REQUIRES_LOGIN,
    schema: z.object({
      status: z.enum(['baseline', 'active', 'completed', 'abandoned']).optional(),
    }),
    handler: (input) => getExperiments(input.status),
  }),
  tool({
    name: 'supstack_experiments_get',
    description:
      "Get one of the signed-in user's experiments in full (protocol, verdict + summary, and check-in responses) by its id." +
      REQUIRES_LOGIN,
    schema: z.object({ id: z.string().min(1) }),
    handler: (input) => getExperiment(input.id),
  }),
  tool({
    name: 'supstack_track_log',
    description:
      "Log a supplement dose for the signed-in user. Omit `supplement` to log the user's whole stack for the day. Defaults to today / taken." +
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
];
