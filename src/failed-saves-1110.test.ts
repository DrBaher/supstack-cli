/**
 * Failed saves and unknown states (the pharmacist, 10 November 2026), on the CLI and the MCP server:
 *
 *   row 3  a lost response on a check-in, restart, correction (and a dose log) prints her text after the original error, keeps the
 *          error and a non-zero exit, is a structured unknown-outcome result on MCP, and the request is sent ONCE (no silent resubmission)
 *   row 4  `experiments list` shows her 748 text beside the raw code, her "could not be interpreted" line for an unmapped code, --json unchanged
 *   row 9  `track log` relays the hold text the server sends (her dose-log text and outcome line), which the client used to drop
 *
 * Each test drives the real command or MCP tool against a fetch stub.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorToJson, printError } from './cli';
import { EXIT, exitCodeFor } from './exit-codes';
import {
  checkInExperiment,
  postCorrection,
  postRestart,
  runExperimentCheckIn,
  runExperimentsList,
} from './experiments';
import { HELD_CODE_TEXT, HELD_CODE_UNINTERPRETED_1110 } from './held-code-text';
import { ApiError } from './http';
import { buildMcpServer } from './mcp';
import { runTrackLog } from './track';
import { DOSE_ENTRY_UNKNOWN_1110, UnknownOutcomeError, UPDATE_OUTCOME_UNKNOWN_750 } from './unknown-outcome';

const ID = '8b03297e-0000-4000-8000-0000000011b1';
const ok = (body: unknown) =>
  ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as unknown as Response;
const refusal = (status: number, body: unknown) =>
  ({ ok: false, status, headers: new Headers(), json: async () => body }) as unknown as Response;

async function capture(fn: () => Promise<unknown>): Promise<{ out: string; err: string; error: unknown }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string): boolean => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string): boolean => (err.push(String(s)), true)) as typeof process.stderr.write;
  let error: unknown = null;
  try {
    await fn();
  } catch (x) {
    error = x;
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { out: out.join(''), err: err.join(''), error };
}
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function mcpCall(name: string, args: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([buildMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { type: string; text: string }[];
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-fs1110-'));
  process.env.SUPSTACK_HOME = home;
  process.env.SUPSTACK_TOKEN = 'sct_live_x';
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  delete process.env.SUPSTACK_TOKEN;
});

/** A connection that dies: the server may or may not have saved the request, the client cannot tell. */
const lost = () => {
  const f = vi.fn(async () => {
    throw new TypeError('fetch failed');
  });
  vi.stubGlobal('fetch', f);
  return f;
};

describe('row 3: a lost response is an unknown outcome, never saved and never failed', () => {
  it('check-in: the error line, then her 750 text, the original error and a non-zero exit, sent once', async () => {
    const f = lost();
    const r = await capture(() => runExperimentCheckIn(ID, ['energy=7'], false));
    expect(r.error).toBeInstanceOf(UnknownOutcomeError);
    const e = r.error as UnknownOutcomeError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(0);
    expect(e.message).toBe('Network error: fetch failed');
    expect(exitCodeFor(e)).toBe(EXIT.NETWORK);
    const shown = await capture(async () => printError(e));
    const text = plain(shown.err);
    expect(text).toContain('API error (network): Network error: fetch failed');
    expect(text).toContain(UPDATE_OUTCOME_UNKNOWN_750);
    expect(text.indexOf('Network error')).toBeLessThan(text.indexOf(UPDATE_OUTCOME_UNKNOWN_750));
    // No silent resubmission of a non-idempotent action.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('restart and correction: the same, one request each', async () => {
    for (const run of [
      () => postRestart(ID, { renewedScreen: {}, restartRecord: {} as never }),
      () =>
        postCorrection(ID, {
          renewedScreen: {},
          checkInNumber: 1,
          correctedAnswers: {},
          affirmedNoEvent: true,
        }),
    ]) {
      const f = lost();
      const r = await capture(run);
      expect(r.error).toBeInstanceOf(UnknownOutcomeError);
      expect((await capture(async () => printError(r.error))).err).toContain(UPDATE_OUTCOME_UNKNOWN_750);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('a timeout is the same, with the original message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init: { signal: AbortSignal }) =>
          new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))),
      ),
    );
    process.env.SUPSTACK_TIMEOUT = '0.01';
    try {
      const r = await capture(() => checkInExperiment(ID, {}));
      expect((r.error as UnknownOutcomeError).message).toMatch(/Request timed out after/);
      expect((r.error as UnknownOutcomeError).outcome).toBe('unknown');
    } finally {
      delete process.env.SUPSTACK_TIMEOUT;
    }
  });

  it('--json keeps the original error and adds the unknown outcome and what to read back', async () => {
    lost();
    const r = await capture(() => checkInExperiment(ID, {}));
    const j = errorToJson(r.error).error as Record<string, unknown>;
    expect(j.type).toBe('api_error');
    expect(j.status).toBe(0);
    expect(j.message).toBe('Network error: fetch failed');
    expect(j.outcome).toBe('unknown');
    expect(j.outcomeMessage).toBe(UPDATE_OUTCOME_UNKNOWN_750);
    expect(j.readBack).toMatchObject({ action: 'check-in', experimentId: ID });
  });

  it('a server answer is never an unknown outcome: a 500 and a 409 print as before, without her text', async () => {
    for (const status of [500, 409]) {
      const f = vi.fn(async () => refusal(status, { error: 'x', message: 'The server said no.' }));
      vi.stubGlobal('fetch', f);
      const r = await capture(() => checkInExperiment(ID, {}));
      expect(r.error).not.toBeInstanceOf(UnknownOutcomeError);
      expect((await capture(async () => printError(r.error))).err).not.toContain(UPDATE_OUTCOME_UNKNOWN_750);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('MCP: check-in, restart and correction return a structured unknown outcome (isError, saved null, her text), one request each', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['supstack_experiment_check_in', { id: ID, answers: {} }],
      [
        'supstack_experiment_restart',
        {
          id: ID,
          renewedScreen: {},
          restartRecord: {
            reviewerRole: 'doctor',
            reviewedOn: '2026-11-01',
            dose: '1 g',
            productForm: 'capsule',
            restartPlan: 'x',
            clinicianAdvisedRestart: true,
            seriousInjury: 'excluded',
            seriousIllness: 'excluded',
            eventResolution: 'resolved',
            otherExposures: 'none',
          },
        },
      ],
      [
        'supstack_experiment_correct',
        { id: ID, renewedScreen: {}, checkInNumber: 1, correctedAnswers: {}, affirmedNoEvent: true },
      ],
    ];
    for (const [name, args] of calls) {
      const f = lost();
      const res = await mcpCall(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.content[0]!.text).toBe(UPDATE_OUTCOME_UNKNOWN_750);
      expect(res.structuredContent).toMatchObject({
        outcome: 'unknown',
        saved: null,
        message: UPDATE_OUTCOME_UNKNOWN_750,
        error: { status: 0 },
      });
      expect(JSON.parse(res.content[1]!.text)).toMatchObject({
        outcome: 'unknown',
        saved: null,
        readBack: { experimentId: ID },
      });
      expect(f, name).toHaveBeenCalledTimes(1);
    }
  });

  it('MCP: a server error on the same tool is the ordinary error, not an unknown outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(500, { error: 'server_error', message: 'Could not save your check-in.' })),
    );
    const res = await mcpCall('supstack_experiment_check_in', { id: ID, answers: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(res.content[0]!.text).not.toContain(UPDATE_OUTCOME_UNKNOWN_750);
  });

  it('a dose log (row 9): a lost response is her dose-entry unknown line, on the CLI and MCP, sent once', async () => {
    const f = lost();
    const r = await capture(() => runTrackLog('magnesium', {}, false));
    expect(r.error).toBeInstanceOf(UnknownOutcomeError);
    expect((await capture(async () => printError(r.error))).err).toContain(DOSE_ENTRY_UNKNOWN_1110);
    expect(f).toHaveBeenCalledTimes(1);
    const f2 = lost();
    const res = await mcpCall('supstack_track_log', { supplement: 'magnesium' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(DOSE_ENTRY_UNKNOWN_1110);
    expect(res.structuredContent).toMatchObject({ outcome: 'unknown', saved: null });
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('the source: no apiPost caller in the three experiment writes or the dose log is left outside the wrapper', async () => {
    const { readFileSync } = await import('node:fs');
    const exp = readFileSync(join(__dirname, 'experiments.ts'), 'utf8');
    for (const route of ['check-in', 'restart', 'correction']) {
      const i = exp.indexOf(`/me/experiments/\${encodeURIComponent(id)}/${route}\``);
      expect(i, route).toBeGreaterThan(-1);
      expect(exp.slice(Math.max(0, i - 160), i), route).toContain('withUnknownOutcome(');
    }
    expect(readFileSync(join(__dirname, 'track.ts'), 'utf8')).toContain("withUnknownOutcome('dose-log'");
    // And apiPost itself never retries: one fetch per call.
    expect(readFileSync(join(__dirname, 'http.ts'), 'utf8')).toMatch(/does NOT cache or retry/);
  });
});

describe('row 4: the held row in `experiments list` carries her 748 text beside the raw code', () => {
  const row = (over: Record<string, unknown>) => ({
    id: ID,
    supplement: { slug: 'calcium', name: 'Calcium' },
    safety: null,
    goal: { id: 'deep-sleep', name: 'Deep sleep' },
    status: 'paused',
    verdict: null,
    progress: { completed: 1, expected: 4 },
    ...over,
  });
  const list = async (rows: unknown[], asJson = false) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ data: rows, meta: { total: rows.length } })),
    );
    return capture(() => runExperimentsList(undefined, asJson));
  };

  it('every mapped code: the raw code stays and her exact text follows', async () => {
    for (const [code, text] of Object.entries(HELD_CODE_TEXT)) {
      const r = await list([row({ held: true, heldReason: { error: code } })]);
      const t = plain(r.out);
      expect(t, code).toContain(code);
      expect(t, code).toContain(text);
      expect(t, code).not.toContain(HELD_CODE_UNINTERPRETED_1110);
    }
  });

  it('an unmapped code: her new line verbatim, the raw code kept, never read as clear', async () => {
    const r = await list([row({ held: true, heldReason: { error: 'some_new_code' } })]);
    const t = plain(r.out);
    expect(t).toContain('some_new_code');
    expect(t).toContain(
      'The safety status could not be interpreted. Check the safety record before starting or resuming an optional experiment.',
    );
    expect(t).not.toMatch(/eligible|resumed\./);
  });

  it('a code of her sheet that a list row cannot give the context for is not shown as its text (a missing restart record is not relabelled)', async () => {
    for (const code of ['restart_record_incomplete', 'restart_refused', 'start_blocked']) {
      const t = plain((await list([row({ held: true, heldReason: { error: code } })])).out);
      expect(t, code).toContain(code);
      expect(t, code).toContain(HELD_CODE_UNINTERPRETED_1110);
    }
  });

  it('held with no readable code: her line, no code', async () => {
    const t = plain((await list([row({ held: true })])).out);
    expect(t).toContain(HELD_CODE_UNINTERPRETED_1110);
  });

  it('not held: no line at all', async () => {
    const t = plain((await list([row({ held: false })])).out);
    expect(t).not.toContain('safety status could not be interpreted');
    for (const text of Object.values(HELD_CODE_TEXT)) expect(t).not.toContain(text);
  });

  it('--json is unchanged: the rows as the server sent them, no text added', async () => {
    const rows = [
      row({ held: true, heldReason: { error: 'app_restart_unavailable', holdState: 'interim' } }),
    ];
    const r = await list(rows, true);
    expect(JSON.parse(r.out)).toEqual({ experiments: rows });
  });
});

describe('row 9: `track log` relays the hold text the server sends', () => {
  const MESSAGE = ['HOLD: the dose-log hold paragraph', 'OUTCOME: the entry outcome line'].join('\n\n');
  it('prints each line of an experiment hold, and keeps experimentHolds in --json and on MCP', async () => {
    const body = {
      data: { date: '2026-11-10', status: 'taken', logged: 1, supplements: ['magnesium'] },
      meta: { experimentHolds: [{ source: 'unreadable', doseEntry: 'saved', message: MESSAGE }] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(body)),
    );
    const r = await capture(() => runTrackLog('magnesium', {}, false));
    const t = plain(r.out);
    expect(t).toContain('HOLD: the dose-log hold paragraph');
    expect(t).toContain('OUTCOME: the entry outcome line');
    const j = await capture(() => runTrackLog('magnesium', {}, true));
    expect(JSON.parse(j.out).experimentHolds[0].message).toBe(MESSAGE);
    const m = await mcpCall('supstack_track_log', { supplement: 'magnesium' });
    expect(JSON.parse(m.content[0]!.text).experimentHolds[0].message).toBe(MESSAGE);
  });
  it('no hold: the result has no experimentHolds key (unchanged)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok({ data: { date: '2026-11-10', status: 'taken', logged: 1, supplements: ['magnesium'] } }),
      ),
    );
    const j = await capture(() => runTrackLog('magnesium', {}, true));
    expect(JSON.parse(j.out)).not.toHaveProperty('experimentHolds');
  });
});
