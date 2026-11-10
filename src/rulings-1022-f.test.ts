/**
 * Pharmacist rulings 704, 705, 706 and 709 (the pharmacist's 645-744 response, owner-
 * approved "yes apply all verbatim" on 22 October 2026) on the CLI and the MCP
 * server: the report on an ended experiment, `--clarify` (a clarification
 * linked to one earlier answer, her W705 text as the server sends it),
 * `correct --report` (the audited correction of an answer saved in a report,
 * her W706 text), and the server's saved text (her W709 with the real state)
 * or its failed text printed as sent, with the urgent action first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseClarify, runExperimentCorrect, runExperimentReport, runExperimentShow } from './experiments';
import { buildMcpServer } from './mcp';

const ID = '8b03297e-0000-4000-8000-000000001022';
const W704 = 'If you may have an emergency, get help now. Do not wait to complete this report.';
const W705H = 'Clarify an earlier safety answer';
const W705B =
  'Select the earlier answer you want to clarify. Tell us whether it was entered by mistake or whether the situation has changed since then. A clarification does not automatically remove a safety restriction.';
const W706H = 'Correct an answer entered by mistake';
const W706B =
  'Use this only if the recorded answer did not describe what happened. If the event happened and later improved, report that change instead.';
const W709_FAILED =
  'Your report could not be saved. Follow the safety instructions shown now. Do not wait to retry if you need urgent care.';
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, headers: new Headers(), json: async () => body }) as unknown as Response;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function capture(fn: () => Promise<unknown>): Promise<{ out: string; error: unknown }> {
  const out: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string): boolean => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string): boolean => (out.push(String(s)), true)) as typeof process.stderr.write;
  let error: unknown = null;
  try {
    await fn();
  } catch (x) {
    error = x;
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { out: out.join(''), error };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-1022f-'));
  process.env.SUPSTACK_HOME = home;
  process.env.SUPSTACK_TOKEN = 'sct_live_x';
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  delete process.env.SUPSTACK_TOKEN;
});

const detail = (status: string) => ({
  id: ID,
  status,
  supplement: { slug: 'magnesium', name: 'Magnesium' },
  goal: { id: 'deep-sleep', name: 'Deep sleep' },
  progress: { completed: 2, expected: 4 },
  safetyAction: null,
  responses: [],
  protocol: null,
  safetyReport: {
    action: 'Report a symptom or safety concern',
    emergencyLine:
      status === 'completed'
        ? W704
        : 'If you have an emergency warning sign, get help now; do not wait to complete this report.',
    questions: [
      {
        id: 'pregnancy-status',
        text: 'Are you pregnant?',
        type: 'choice',
        category: 'safety',
        required: true,
        options: [
          { value: 'no', label: 'No' },
          { value: 'possibly-pregnant', label: 'I might be' },
        ],
      },
    ],
    clarify: { heading: W705H, body: W705B },
    correct: { heading: W706H, body: W706B },
    savedAnswers: [
      {
        reportNumber: 1,
        questionId: 'pregnancy-status',
        question: 'Are you pregnant?',
        value: 'possibly-pregnant',
        acts: 'status-hold',
      },
    ],
  },
});
const ACTION = {
  category: 'emergency',
  pauses: true,
  restartNeedsClinicianReview: true,
  restartRequires: 'documented-clearance',
  heading: 'Get emergency help now',
  instruction: 'EMERGENCY INSTRUCTION',
  checkInNumber: null,
  safetyReportNumber: 2,
  actions: [],
};

describe('parseClarify', () => {
  it('takes <reportNumber>:<questionId> and an optional kind, and refuses anything else', () => {
    expect(parseClarify('1:pregnancy-status')).toEqual({ reportNumber: 1, questionId: 'pregnancy-status' });
    expect(parseClarify('12:red-flag-signs', 'entered-by-mistake')).toEqual({
      reportNumber: 12,
      questionId: 'red-flag-signs',
      kind: 'entered-by-mistake',
    });
    expect(() => parseClarify('pregnancy-status')).toThrow(/reportNumber>:<questionId/);
    expect(() => parseClarify('1:q', 'it-improved')).toThrow(/situation-changed or entered-by-mistake/);
  });
});

describe('704 on the CLI', () => {
  it("show prints the report action and the server's W704 line on a completed experiment", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { data: detail('completed') })),
    );
    const r = await capture(() => runExperimentShow(ID, false));
    expect(plain(r.out)).toContain(W704);
  });
});

describe('705 on the CLI: report --clarify', () => {
  it('no answers: her W705 text from the server, the saved answers, her W706 text, and the one question to answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { data: detail('paused') })),
    );
    const listing = await capture(() => runExperimentReport(ID, [], false));
    const t = plain(listing.out);
    expect(t).toContain(W705H);
    expect(t).toContain(W705B);
    expect(t).toContain('report 1  pregnancy-status: possibly-pregnant');
    expect(t).toContain(W706H);
    expect(t).toContain(W706B);
    const one = await capture(() => runExperimentReport(ID, [], false, { raw: '1:pregnancy-status' }));
    expect(plain(one.out)).toContain(W705B);
    expect(plain(one.out)).toContain('Answer again');
    expect(plain(one.out)).toContain('pregnancy-status');
    expect(plain(one.out)).toMatch(/--clarify 1:pregnancy-status/);
  });
  it("with answers: the request names the answer it clarifies; the server's saved text and the clarification are printed", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).endsWith('/safety-report')
        ? json(201, {
            data: {
              reportNumber: 2,
              safetyAction: null,
              paused: false,
              statusHold: false,
              checkInsCompleted: 2,
              experimentStatus: 'active',
              saved: 'Your report has been saved. Experiment status: In Progress.',
              clarification: {
                reportNumber: 2,
                clarifies: { reportNumber: 1, questionId: 'pregnancy-status', kind: 'situation-changed' },
                originalActs: 'status-hold',
                statusHoldResolved: true,
                restrictionKept: false,
              },
            },
          })
        : json(200, { data: detail('paused') }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await capture(() =>
      runExperimentReport(ID, ['pregnancy-status=no'], false, { raw: '1:pregnancy-status' }),
    );
    expect(r.error).toBeNull();
    const t = plain(r.out);
    expect(t).toContain('Your report has been saved. Experiment status: In Progress.');
    expect(t).toMatch(/Clarifies report 1, pregnancy-status\. That answer no longer holds the experiment\./);
    expect(t).not.toMatch(/Every restriction stays recorded/);
    const posted = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/safety-report'))!;
    expect(JSON.parse(String((posted[1] as RequestInit).body))).toEqual({
      answers: { 'pregnancy-status': 'no' },
      clarifies: { reportNumber: 1, questionId: 'pregnancy-status' },
    });
  });
  it('a restriction that stays is said so; nothing says saved when the server did not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(201, {
          data: {
            reportNumber: 2,
            safetyAction: null,
            paused: false,
            statusHold: false,
            checkInsCompleted: 2,
            clarification: {
              reportNumber: 2,
              clarifies: { reportNumber: 1, questionId: 'red-flag-signs', kind: 'situation-changed' },
              originalActs: 'pauses',
              statusHoldResolved: false,
              restrictionKept: true,
            },
          },
        }),
      ),
    );
    const r = await capture(() =>
      runExperimentReport(ID, ['red-flag-signs=none'], false, { raw: '1:red-flag-signs' }),
    );
    expect(plain(r.out)).toMatch(/Every restriction stays recorded\./);
    expect(plain(r.out)).not.toMatch(/has been saved/);
  });
  it('a failed save: the urgent action first, then her W709 failed text as the server sent it, never a saved line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(500, {
          error: 'server_error',
          message: 'Could not save the report. Any hold above is in place.',
          safetyAction: ACTION,
          saveFailed: W709_FAILED,
        }),
      ),
    );
    const r = await capture(() => runExperimentReport(ID, ['red-flag-signs=now'], false));
    const t = plain(r.out);
    expect(t).toContain(W709_FAILED);
    expect(t).not.toMatch(/has been saved|recorded\./);
    expect(r.error).toBeTruthy();
  });
});

describe('706 on the CLI: correct --report', () => {
  it("sends reportNumber, not checkInNumber, with the corrected answers, the screen and the affirmation, and prints the server's saved text", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).endsWith('/correction')
        ? json(200, {
            data: {
              id: ID,
              status: 'active',
              corrected: true,
              released: true,
              reportNumber: 1,
              saved: 'Your report has been saved. Experiment status: In Progress.',
            },
          })
        : json(200, { data: detail('paused') }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await capture(() =>
      runExperimentCorrect(
        ID,
        { report: 1, answers: ['red-flag-signs=none'], screen: ['pregnancy-status=no'], affirm: true },
        false,
      ),
    );
    expect(r.error).toBeNull();
    const posted = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/correction'))!;
    const body = JSON.parse(String((posted[1] as RequestInit).body));
    expect(body).toEqual({
      reportNumber: 1,
      correctedAnswers: { 'red-flag-signs': 'none' },
      renewedScreen: { 'pregnancy-status': 'no' },
      affirmedNoEvent: true,
    });
    expect(body).not.toHaveProperty('checkInNumber');
    expect(plain(r.out)).toContain('Your report has been saved. Experiment status: In Progress.');
    expect(plain(r.out)).toMatch(/Corrected as a mistake/);
  });
  it('a correction that leaves the pause says so (released false), with its saved text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(200, {
          data: {
            id: ID,
            status: 'paused',
            corrected: true,
            released: false,
            remainingHolds: 1,
            reportNumber: 1,
            saved: 'Your report has been saved. Experiment status: Paused.',
          },
        }),
      ),
    );
    const r = await capture(() =>
      runExperimentCorrect(
        ID,
        { report: 1, answers: ['red-flag-signs=none'], screen: [], affirm: true },
        false,
      ),
    );
    expect(plain(r.out)).toMatch(/The experiment stays paused/);
    expect(plain(r.out)).toContain('Experiment status: Paused.');
  });
  it('--report must be a number, the affirmation is still required, and a check-in number is still required without --report', async () => {
    await expect(
      runExperimentCorrect(ID, { report: 0, answers: [], screen: [], affirm: true }, false),
    ).rejects.toThrow(/--report takes the number of a saved safety report/);
    await expect(
      runExperimentCorrect(ID, { report: 1, answers: [], screen: [], affirm: false }, false),
    ).rejects.toThrow(/--affirm/);
    await expect(runExperimentCorrect(ID, { answers: [], screen: [], affirm: true }, false)).rejects.toThrow(
      /--check-in/,
    );
  });
});

describe('704 to 706 on the MCP server', () => {
  async function client() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([buildMcpServer().connect(serverTransport), c.connect(clientTransport)]);
    return c;
  }
  it('the report tool takes `clarifies` and says ended experiments are reported on too; the correct tool takes `reportNumber`', async () => {
    const fetchMock = vi.fn(async () =>
      json(201, {
        data: { reportNumber: 2, safetyAction: null, paused: false, statusHold: false, checkInsCompleted: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const c = await client();
    const tools = (await c.listTools()).tools;
    const report = tools.find((t) => t.name === 'supstack_experiment_report_safety')!;
    expect(report.description).toMatch(/ended/);
    expect(report.description).toMatch(/clarifies/);
    expect(JSON.stringify(report.inputSchema)).toMatch(/clarifies/);
    await c.callTool({
      name: 'supstack_experiment_report_safety',
      arguments: {
        id: ID,
        answers: { 'pregnancy-status': 'no' },
        clarifies: { reportNumber: 1, questionId: 'pregnancy-status' },
      },
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual(
      {
        answers: { 'pregnancy-status': 'no' },
        clarifies: { reportNumber: 1, questionId: 'pregnancy-status' },
      },
    );
    const correct = tools.find((t) => t.name === 'supstack_experiment_correct')!;
    expect(JSON.stringify(correct.inputSchema)).toMatch(/reportNumber/);
    expect(correct.description).toMatch(/SAVED in a safety report/);
    fetchMock.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { data: { id: ID, corrected: true, released: false, remainingHolds: 1 } })),
    );
    await c.callTool({
      name: 'supstack_experiment_correct',
      arguments: {
        id: ID,
        reportNumber: 1,
        correctedAnswers: { 'red-flag-signs': 'none' },
        renewedScreen: { 'pregnancy-status': 'no' },
        affirmedNoEvent: true,
      },
    });
  });
});
