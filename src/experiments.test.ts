import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotLoggedInError } from './cloud-stack';
import {
  abandonExperiment,
  checkInExperiment,
  getExperiment,
  getExperimentProtocol,
  getExperiments,
  isQuestionAsked,
  isRequiredSafetyQuestion,
  parseAnswers,
  postCorrection,
  postRestart,
  printSafetyAction,
  resolveExperimentId,
  runExperimentCheckIn,
  runExperimentCorrect,
  runExperimentsList,
  runExperimentStart,
  startExperiment,
} from './experiments';

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

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-exp-'));
  process.env.SUPSTACK_HOME = home;
  delete process.env.SUPSTACK_TOKEN;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('experiments', () => {
  it('requires a token', async () => {
    await expect(getExperiments()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(getExperiment('abc')).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('getExperiments GETs /me/experiments with the status filter + Bearer', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: [
          {
            id: 'exp-1',
            supplement: { slug: 'magnesium', name: 'Magnesium' },
            goal: { id: 'deep-sleep', name: 'Deep Sleep' },
            status: 'active',
            verdict: null,
            verdictSummary: null,
            progress: { completed: 2, expected: 4 },
            startedAt: '2026-05-01',
            completedAt: null,
            nextCheckInDate: '2026-06-10',
          },
        ],
      }),
    );
    const out = await getExperiments('active', fetchImpl as unknown as typeof fetch);
    expect(out[0]?.supplement.name).toBe('Magnesium');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/experiments?status=active');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('getExperiment GETs /me/experiments/:id', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          id: 'exp-1',
          supplement: { slug: 'magnesium', name: 'Magnesium' },
          goal: { id: 'deep-sleep', name: 'Deep Sleep' },
          status: 'completed',
          verdict: 'clear-win',
          verdictSummary: 'Slept better.',
          verdictDetails: null,
          protocol: null,
          progress: { completed: 4, expected: 4 },
          startedAt: '2026-05-01',
          baselineCompletedAt: '2026-05-02',
          completedAt: '2026-05-30',
          nextCheckInDate: null,
          responses: [],
        },
      }),
    );
    const out = await getExperiment('exp-1', fetchImpl as unknown as typeof fetch);
    expect(out.verdict).toBe('clear-win');
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url)).toContain('/me/experiments/exp-1');
  });

  it('resolveExperimentId passes a full uuid through without a network call', async () => {
    const uuid = '8b03297e-0000-4000-8000-000000000000';
    await expect(resolveExperimentId(uuid)).resolves.toBe(uuid);
  });

  it('resolveExperimentId resolves a short prefix via the list', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const full = '8b03297e-1111-4111-8111-111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: [
            {
              id: full,
              supplement: { slug: 'magnesium', name: 'Magnesium' },
              goal: { id: 'g', name: 'G' },
              status: 'completed',
              verdict: null,
              verdictSummary: null,
              progress: { completed: 4, expected: 4 },
              startedAt: null,
              completedAt: null,
              nextCheckInDate: null,
            },
            {
              id: 'd3d0de39-2222-4222-8222-222222222222',
              supplement: { slug: 'l-theanine', name: 'L-Theanine' },
              goal: { id: 'g', name: 'G' },
              status: 'completed',
              verdict: null,
              verdictSummary: null,
              progress: { completed: 4, expected: 4 },
              startedAt: null,
              completedAt: null,
              nextCheckInDate: null,
            },
          ],
        }),
      ),
    );
    await expect(resolveExperimentId('8b03297e')).resolves.toBe(full);
    await expect(resolveExperimentId('zzzz')).rejects.toThrow(/No experiment matching/);
    vi.unstubAllGlobals();
  });

  it('resolveExperimentId rejects an ambiguous prefix', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const item = (id: string): unknown => ({
      id,
      supplement: { slug: 's', name: 'S' },
      goal: { id: 'g', name: 'G' },
      status: 'completed',
      verdict: null,
      verdictSummary: null,
      progress: { completed: 1, expected: 1 },
      startedAt: null,
      completedAt: null,
      nextCheckInDate: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: [item('abcd1111-0000-4000-8000-000000000000'), item('abcd2222-0000-4000-8000-000000000000')],
        }),
      ),
    );
    await expect(resolveExperimentId('abcd')).rejects.toThrow(/ambiguous/);
    vi.unstubAllGlobals();
  });

  it('runExperimentsList renders rows (and an empty state)', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    // Empty.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ data: [] })));
    expect(await captureStdout(() => runExperimentsList(undefined, false))).toContain('No experiments yet');
    vi.unstubAllGlobals();
    // Populated.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: [
            {
              id: '8b03297e-1111-4111-8111-111111111111',
              supplement: { slug: 'magnesium', name: 'Magnesium' },
              goal: { id: 'deep-sleep', name: 'Deep Sleep' },
              status: 'completed',
              verdict: 'clear-win',
              verdictSummary: null,
              progress: { completed: 4, expected: 4 },
              startedAt: null,
              completedAt: null,
              nextCheckInDate: null,
            },
          ],
        }),
      ),
    );
    const out = await captureStdout(() => runExperimentsList(undefined, false));
    expect(out).toContain('Magnesium');
    expect(out).toContain('Deep Sleep');
    expect(out).toContain('4/4');
    expect(out).toContain('clear-win');
    expect(out).toContain('8b03297e'); // short id
    vi.unstubAllGlobals();
  });
});

describe('experiments write', () => {
  it('parseAnswers parses id=value and rejects malformed input', () => {
    expect(parseAnswers(['sleep-onset=25', 'mood=good'])).toEqual({ 'sleep-onset': '25', mood: 'good' });
    expect(parseAnswers(['notes=a=b'])).toEqual({ notes: 'a=b' }); // only first =
    expect(() => parseAnswers(['bogus'])).toThrow(/id=value/);
    expect(() => parseAnswers(['=novalue'])).toThrow();
  });

  it('startExperiment POSTs supplement+goal+answers with the Bearer token', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ data: { id: 'e1', status: 'active', progress: { completed: 0, expected: 4 } } }),
      );
    await startExperiment(
      'magnesium',
      'deep-sleep',
      { 'sleep-onset': '25' },
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/experiments');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      supplement: 'magnesium',
      goal: 'deep-sleep',
      answers: { 'sleep-onset': '25' },
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });

  it('owner decision 3: startExperiment sends the restart record of an earlier safety-paused experiment', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ data: { id: 'e1', status: 'active', progress: { completed: 0, expected: 4 } } }),
      );
    const restartRecord = {
      reviewerRole: 'doctor',
      reviewedOn: '2026-10-04',
      dose: '200 mg',
      restartPlan: 'Half the dose for two weeks',
      clinicianAdvisedRestart: true,
    };
    await startExperiment(
      'magnesium',
      'deep-sleep',
      {},
      fetchImpl as unknown as typeof fetch,
      [],
      restartRecord,
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).restartRecord).toEqual(restartRecord);
  });

  it('checkInExperiment POSTs to the check-in endpoint', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: { id: 'e1', status: 'active', checkInNumber: 1, progress: { completed: 1, expected: 4 } },
      }),
    );
    await checkInExperiment('e1', { 'sleep-onset': '15' }, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/experiments/e1/check-in');
    expect(init.method).toBe('POST');
  });

  it('getExperimentProtocol GETs the protocol endpoint with both params', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ data: { baselineQuestions: [], checkInQuestions: [] } }));
    await getExperimentProtocol('magnesium', 'deep-sleep', fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url)).toContain('/me/experiments/protocol?supplement=magnesium&goal=deep-sleep');
  });

  it('runExperimentStart with no --answer shows the baseline questions (does not create)', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          supplement: { id: 'magnesium', name: 'Magnesium', slug: 'magnesium' },
          goal: { id: 'deep-sleep', name: 'Deep sleep' },
          dosing: { dose: '400mg', timing: 'bedtime' },
          schedule: { totalCheckIns: 4 },
          baselineQuestions: [
            { id: 'sleep-onset', text: 'Onset?', type: 'number', category: 'primary', required: true },
          ],
          checkInQuestions: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await captureStdout(() => runExperimentStart('magnesium', 'deep-sleep', [], false));
    expect(out).toContain('Baseline questions');
    expect(out).toContain('sleep-onset');
    // It previewed, not created — only the protocol GET happened.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/protocol');
    expect(
      fetchMock.mock.calls.every(
        (c) => !String((c[1] as RequestInit)?.method) || (c[1] as RequestInit).method !== 'POST',
      ),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it('abandonExperiment POSTs to the abandon endpoint with the Bearer token', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          id: 'e1',
          status: 'abandoned',
          supplement: { slug: 'magnesium', name: 'Magnesium' },
          goal: { id: 'deep-sleep', name: 'Deep sleep' },
        },
      }),
    );
    const r = await abandonExperiment('e1', fetchImpl as unknown as typeof fetch);
    expect(r.status).toBe('abandoned');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/experiments/e1/abandon');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sct_live_x');
  });
});

describe('safety questions at a check-in (owner decision 2026-10-05)', () => {
  it('isRequiredSafetyQuestion matches the app rule: every safety yes/no, choice, multi and (ruling 220 Q8) free-text question', () => {
    expect(isRequiredSafetyQuestion({ category: 'safety', type: 'yesno' })).toBe(true);
    expect(isRequiredSafetyQuestion({ category: 'safety', type: 'choice' })).toBe(true);
    expect(isRequiredSafetyQuestion({ category: 'safety', type: 'multi' })).toBe(true);
    // An empty "other products" field is unanswered, not none.
    expect(isRequiredSafetyQuestion({ category: 'safety', type: 'text' })).toBe(true);
    expect(isRequiredSafetyQuestion({ category: 'secondary', type: 'yesno' })).toBe(false);
  });

  it('ruling 220 Q50: a follow-up asked after any answer but "none", including a multi-select parent', () => {
    const q = { askIf: { questionId: 'side-effects', values: [], anyExcept: ['none'] } };
    expect(isQuestionAsked(q, { 'side-effects': ['headache'] })).toBe(true);
    expect(isQuestionAsked(q, { 'side-effects': ['none'] })).toBe(false);
    expect(isQuestionAsked(q, { 'side-effects': 'not sure' })).toBe(true);
    expect(isQuestionAsked(q, {})).toBe(false);
  });

  it('the check-in question list marks every safety question required and offers not-sure', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const id = '11111111-1111-4111-8111-111111111111';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          id,
          status: 'active',
          supplement: { slug: 'nattokinase', name: 'Nattokinase' },
          goal: { id: 'vein-health', name: 'Vein health' },
          progress: { completed: 1, expected: 4 },
          safetyAction: null,
          protocol: {
            checkIn: {
              questions: [
                { id: 'clot-warning-signs', text: 'Leg?', type: 'yesno', category: 'safety' },
                {
                  id: 'bruising-natto',
                  text: 'Bruising?',
                  type: 'choice',
                  category: 'safety',
                  options: [{ value: 'none', label: 'None' }],
                },
                { id: 'notes', text: 'Notes?', type: 'text', category: 'context' },
              ],
            },
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await captureStdout(() => runExperimentCheckIn(id, [], true));
    vi.unstubAllGlobals();
    const qs = JSON.parse(out).checkInQuestions as { id: string; required: boolean }[];
    expect(qs.find((q) => q.id === 'clot-warning-signs')?.required).toBe(true);
    expect(qs.find((q) => q.id === 'bruising-natto')?.required).toBe(true);
    expect(qs.find((q) => q.id === 'notes')?.required).toBe(false);

    vi.stubGlobal('fetch', fetchMock);
    const text = await captureStdout(() => runExperimentCheckIn(id, [], false));
    vi.unstubAllGlobals();
    expect(text).toContain('yes | no | not-sure');
    expect(text).toContain('none | not-sure');
  });
});

describe('status holds and the post-submit correction (pharmacist rulings 239 and 241 call 1)', () => {
  it('postCorrection sends the status-hold release to the correction route with only renewedScreen', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ data: { id: 'e1', status: 'active', statusHoldReleased: true, nextCheckInDate: null } }),
      );
    const r = await postCorrection(
      'e1',
      { renewedScreen: { 'pregnancy-status': 'no' } },
      fetchImpl as unknown as typeof fetch,
    );
    expect(r.statusHoldReleased).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/experiments/e1/correction');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ renewedScreen: { 'pregnancy-status': 'no' } });
  });

  it('postRestart sends the renewed screen and the restart record to the restart route (ruling 261)', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: { id: 'e1', status: 'active', restartRecordStored: true, restartBasis: 'clinician-advised' },
      }),
    );
    const record = {
      reviewerRole: 'doctor',
      reviewedOn: '2026-10-06',
      dose: '200 mg',
      clinicianAdvisedRestart: true,
    };
    const r = await postRestart(
      'e1',
      { renewedScreen: { 'red-flag-signs': 'none' }, restartRecord: record },
      fetchImpl as unknown as typeof fetch,
    );
    expect(r.restartRecordStored).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me/experiments/e1/restart');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      renewedScreen: { 'red-flag-signs': 'none' },
      restartRecord: record,
    });
  });

  it('the MCP server has the correction and restart tools, and no description says either is missing', async () => {
    const { AUTHED_TOOLS } = await import('./mcp-authed');
    const names = AUTHED_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['supstack_experiment_correct', 'supstack_experiment_restart']),
    );
    for (const t of AUTHED_TOOLS) expect(t.description, t.name).not.toMatch(/no (restart|correction) tool/);
    expect(AUTHED_TOOLS.find((t) => t.name === 'supstack_experiment_restart')?.mutates).toBe(true);
  });

  it('correct refuses without --affirm and without a check-in number, before any request', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRes({ data: [{ id: 'e1aaaaaa-0000-0000-0000-000000000000' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const id = 'e1aaaaaa-0000-0000-0000-000000000000';
    await expect(
      runExperimentCorrect(
        id,
        { checkIn: 2, answers: ['dark-stool-iron=no'], screen: [], affirm: false },
        false,
      ),
    ).rejects.toThrow(/--affirm/);
    await expect(
      runExperimentCorrect(id, { checkIn: undefined, answers: [], screen: [], affirm: true }, false),
    ).rejects.toThrow(/--check-in/);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/correction'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('correct posts every field the route needs, affirmedNoEvent included', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const id = 'e1aaaaaa-0000-0000-0000-000000000000';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        data: { id, status: 'active', corrected: true, notClinicalClearance: true, nextCheckInDate: null },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const text = await captureStdout(() =>
      runExperimentCorrect(
        id,
        {
          checkIn: 2,
          answers: ['dark-stool-iron=no'],
          screen: ['red-flag-signs=none', 'pregnancy-status=no'],
          affirm: true,
        },
        false,
      ),
    );
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/correction'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      checkInNumber: 2,
      correctedAnswers: { 'dark-stool-iron': 'no' },
      renewedScreen: { 'red-flag-signs': 'none', 'pregnancy-status': 'no' },
      affirmedNoEvent: true,
    });
    expect(text).toContain('not a clinical review');
    vi.unstubAllGlobals();
  });

  it('a hold action prints its own heading and the status-hold line, not a safety pause', async () => {
    const text = await captureStdout(async () =>
      printSafetyAction({
        category: 'hold',
        statusHold: true,
        pauses: false,
        restartNeedsClinicianReview: false,
        instruction:
          'Hold your next dose of this optional supplement until you know whether you are pregnant.',
        checkInNumber: 2,
        actions: [],
      }),
    );
    expect(text).toContain('Hold your next dose until this is clear');
    expect(text).toContain('clarify-status');
    expect(text).not.toContain('The experiment is paused: no next check-in');
  });
});

describe('rulings 279 to 282 on the CLI and the MCP server', () => {
  it('ruling 281 call 1: --serious-illness is one answer, or one per named illness', async () => {
    const { seriousIllnessFromFlags } = await import('./experiments');
    expect(seriousIllnessFromFlags(['excluded'])).toEqual({ seriousIllness: 'excluded' });
    expect(seriousIllnessFromFlags(['kidney=excluded', 'serious=confirmed'])).toEqual({
      seriousIllnessBy: { kidney: 'excluded', serious: 'confirmed' },
    });
    expect(seriousIllnessFromFlags([])).toEqual({});
  });

  it('ruling 280: --plan-file accepts one plan, a list or { populationPlans }, and the regimen file is sent as is', async () => {
    const { planFilesFromFlags } = await import('./experiments');
    const dir = mkdtempSync(join(tmpdir(), 'plans-'));
    const { writeFileSync } = await import('node:fs');
    const plan = { kind: 'lactation', coversBoth: false };
    writeFileSync(join(dir, 'one.json'), JSON.stringify(plan));
    writeFileSync(join(dir, 'wrapped.json'), JSON.stringify({ populationPlans: [plan, plan] }));
    writeFileSync(join(dir, 'reg.json'), JSON.stringify({ amount: 0.5, unit: 'mg' }));
    expect(planFilesFromFlags({ planFile: join(dir, 'one.json') }).populationPlans).toEqual([plan]);
    expect(planFilesFromFlags({ planFile: join(dir, 'wrapped.json') }).populationPlans).toHaveLength(2);
    expect(planFilesFromFlags({ currentRegimenFile: join(dir, 'reg.json') }).currentRegimen).toEqual({
      amount: 0.5,
      unit: 'mg',
    });
    expect(() => planFilesFromFlags({ planFile: join(dir, 'missing.json') })).toThrow(/cannot read/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ruling 281 call 2: correct names only the events given, and a partial result says the pause stays', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const id = 'e1aaaaaa-0000-0000-0000-000000000000';
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          id,
          status: 'paused',
          corrected: true,
          released: false,
          remainingHolds: 1,
          note: 'Your correction of this answer is recorded. Another answer or event still holds this experiment, so it stays paused until that one is resolved.',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const text = await captureStdout(() =>
      runExperimentCorrect(
        id,
        {
          checkIn: 3,
          answers: ['x=none'],
          screen: ['red-flag-signs=none'],
          affirm: true,
          eventIds: ['ev-1'],
        },
        false,
      ),
    );
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/correction'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).eventIds).toEqual(['ev-1']);
    expect(text).toContain('stays paused');
    expect(text).not.toContain('Corrected as a mistake.');
    vi.unstubAllGlobals();
  });

  it('ruling 282 call 1: no generic not-sure is offered for the low blood sugar questions, which stay required', async () => {
    const { questionHint, NO_GENERIC_NOT_SURE, isRequiredSafetyQuestion } = await import('./experiments');
    for (const id of NO_GENERIC_NOT_SURE) {
      const q = {
        id,
        text: 't',
        type: 'choice',
        category: 'safety',
        required: true,
        options: [
          { value: 'maybe-now', label: 'a' },
          { value: 'unsure-past', label: 'b' },
        ],
      };
      expect(isRequiredSafetyQuestion(q)).toBe(true);
      expect(questionHint(q)).not.toContain('not-sure');
    }
  });

  it('the MCP restart tool takes the per-illness answers, the SJS/TEN answer and the typed plans; correct takes eventIds', async () => {
    const { AUTHED_TOOLS } = await import('./mcp-authed');
    const restart = AUTHED_TOOLS.find((t) => t.name === 'supstack_experiment_restart')!;
    const parsed = restart.schema.safeParse({
      id: 'x',
      restartRecord: {
        reviewerRole: 'doctor',
        reviewedOn: '2026-10-07',
        dose: '1',
        restartPlan: 'plan',
        clinicianAdvisedRestart: true,
        seriousIllness: 'confirmed',
        seriousIllnessBy: { kidney: 'excluded' },
        seriousIllnessAppliesToAll: true,
        sjsTen: 'ruled-out',
        currentRegimen: {
          product: 'P',
          ingredients: 'I',
          chemicalForm: 'F',
          route: 'oral',
          amount: 0.5,
          unit: 'mcg',
          basis: 'per-dose',
          measure: 'compound-mass',
          release: 'immediate',
          timesPer: 1,
          period: 'week',
          schedule: 'morning',
        },
      },
    });
    expect(parsed.success).toBe(true);
    // Ruling 293/T3: four answers; the retired binary "not-confirmed" is refused, never read as ruled out.
    for (const v of ['confirmed-culprit', 'ruled-out', 'suspected', 'not-assessed']) {
      expect(
        restart.schema.safeParse({
          id: 'x',
          restartRecord: {
            reviewerRole: 'doctor',
            reviewedOn: '2026-10-07',
            dose: '1',
            restartPlan: 'plan',
            clinicianAdvisedRestart: true,
            sjsTen: v,
          },
        }).success,
        v,
      ).toBe(true);
    }
    expect(
      restart.schema.safeParse({
        id: 'x',
        restartRecord: {
          reviewerRole: 'doctor',
          reviewedOn: '2026-10-07',
          dose: '1',
          restartPlan: 'plan',
          clinicianAdvisedRestart: true,
          sjsTen: 'not-confirmed',
        },
      }).success,
    ).toBe(false);
    expect(restart.description).toMatch(/complete named list/);
    const correct = AUTHED_TOOLS.find((t) => t.name === 'supstack_experiment_correct')!;
    expect(correct.schema.safeParse({ id: 'x', eventIds: ['e'] }).success).toBe(true);
    expect(correct.description).toMatch(/released: false/);
  });
});
