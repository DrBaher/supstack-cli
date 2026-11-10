/**
 * Owner calls O-5 and O-6 (14 October 2026, "Accept all") on the CLI and the
 * MCP server: what the reader (or the model) receives. Each test drives the
 * real command or a real MCP tool call against a fetch that answers with the
 * API's body, and reads stdout, stderr or the tool result's content blocks.
 *
 *   O-5: `409 population_blocked` now comes for every product. The CLI prints
 *        its message, her pre-start rule and her pre-start footer, `--json`
 *        keeps both, and MCP relays them first.
 *   O-6: `held` and `heldRefusal` on the experiment read. `experiments show`
 *        and `experiments restart` (no flags) print the refusal and ask for no
 *        restart record, `list` marks the row with the code, MCP relays it first.
 *
 * Every string below stands in for the server's text: the CLI only prints
 * what it is sent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorToJson, printError } from './cli';
import {
  runExperimentRestart,
  runExperimentShow,
  runExperimentsList,
  runExperimentStart,
} from './experiments';
import { ApiError } from './http';
import { buildMcpServer } from './mcp';

const ID = '8b03297e-0000-4000-8000-0000000014a6';
const LEAD = 'LEAD: the server urgent lead';
const ACTION = 'ACTION: the server action paragraph';
const HOLD = 'HOLD: the server hold paragraph';
const FOOTER = 'FOOTER: the server paused footer';
const heldRefusal = {
  error: 'app_restart_unavailable',
  holdState: 'interim',
  message: [LEAD, ACTION, HOLD].join('\n\n'),
  refusal: { urgentLead: LEAD, actions: [ACTION], hold: [HOLD] },
  footer: FOOTER,
  heldRows: [{ row: 'S-023', reason: 'product-severe', state: 'unresolved-review' }],
};
const detail = (held: boolean) => ({
  id: ID,
  supplement: { slug: 'calcium', name: 'Calcium' },
  safety: null,
  goal: { id: 'deep-sleep', name: 'Deep sleep' },
  status: 'paused',
  verdict: null,
  verdictSummary: null,
  progress: { completed: 1, expected: 4 },
  startedAt: null,
  completedAt: null,
  nextCheckInDate: null,
  safetyAction: null,
  pausedForSafety: true,
  restartRequires: 'clinician-advised',
  held,
  ...(held ? { heldRefusal } : {}),
  checkInQuestions: [],
  verdictDetails: null,
  protocol: null,
  baselineCompletedAt: null,
  responses: [],
});
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
    content: { type: string; text: string }[];
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-o5o6-'));
  process.env.SUPSTACK_HOME = home;
  process.env.SUPSTACK_TOKEN = 'sct_live_x';
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  delete process.env.SUPSTACK_TOKEN;
});

describe('O-6 on the CLI: a held experiment shows its refusal before any restart is attempted', () => {
  it('experiments show: the lead first, then the action, the hold, the footer, the code; no restart-record hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ data: detail(true) })),
    );
    const r = await capture(() => runExperimentShow(ID, false));
    expect(r.error).toBeNull();
    const t = plain(r.out);
    const at = (s: string) => {
      const i = t.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at(LEAD)).toBeLessThan(at(ACTION));
    expect(at(ACTION)).toBeLessThan(at(HOLD));
    expect(at(HOLD)).toBeLessThan(at(FOOTER));
    expect(at(FOOTER)).toBeLessThan(at('(app_restart_unavailable)'));
    expect(t).not.toContain('It restarts only with the restart record');
  });

  it('experiments restart with no flags: the refusal, and no record asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ data: detail(true) })),
    );
    const r = await capture(() => runExperimentRestart(ID, { screen: [], record: {} as never }, false));
    expect(r.error).toBeNull();
    expect(plain(r.out)).toContain(LEAD);
    expect(plain(r.out)).not.toContain('Submit with:');
  });

  it('anti-vacuity: not held, the restart hint and the record request are printed as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ data: detail(false) })),
    );
    const show = await capture(() => runExperimentShow(ID, false));
    expect(plain(show.out)).toContain('It restarts only with the restart record');
    expect(plain(show.out)).not.toContain(LEAD);
    const r = await capture(() => runExperimentRestart(ID, { screen: [], record: {} as never }, false));
    expect(plain(r.out)).toContain('Submit with:');
  });

  it('experiments list marks a held row with its code only', async () => {
    const row = { ...detail(true), heldReason: { error: 'app_restart_unavailable', holdState: 'interim' } };
    delete (row as Record<string, unknown>).heldRefusal;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ data: [row], meta: { total: 1 } })),
    );
    const r = await capture(() => runExperimentsList(undefined, false));
    expect(plain(r.out)).toContain('app_restart_unavailable');
    expect(plain(r.out)).not.toContain(LEAD);
  });

  it('MCP supstack_experiments_get: the refusal is relayed first, in order, ahead of the JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ data: detail(true) })),
    );
    const res = await mcpCall('supstack_experiments_get', { id: ID });
    const first = res.content[0]!.text;
    expect(first).toContain('show these to the user first');
    expect(first.indexOf(LEAD)).toBeGreaterThan(-1);
    expect(first.indexOf(LEAD)).toBeLessThan(first.indexOf(ACTION));
    expect(first.indexOf(HOLD)).toBeLessThan(first.indexOf(FOOTER));
    const plainRead = await (async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok({ data: detail(false) })),
      );
      return mcpCall('supstack_experiments_get', { id: ID });
    })();
    expect(plainRead.content[0]!.text).not.toContain(LEAD);
  });
});

describe('O-5 on the CLI and MCP: population_blocked for any product prints its message, her rule and her footer', () => {
  const MESSAGE = 'MESSAGE: the server population risk';
  const RULE = 'RULE: the server pre-start rule';
  const PRESTART = 'PRESTART: the server pre-start footer';
  const body = {
    error: 'population_blocked',
    message: MESSAGE,
    safety: { level: 'block', risks: [MESSAGE] },
    eligibility: RULE,
    footer: PRESTART,
  };

  it('experiments start: the rule from the command, the message and the footer from printError, and --json keeps both', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(409, body)),
    );
    const r = await capture(() => runExperimentStart('ashwagandha', 'reduce-anxiety', ['x=1'], false));
    expect(r.error).toBeInstanceOf(ApiError);
    expect(plain(r.out)).toContain(RULE);
    const p = await capture(async () => printError(r.error));
    expect(plain(p.err)).toContain(MESSAGE);
    expect(plain(p.err)).toContain(PRESTART);
    const j = errorToJson(r.error) as { error: { eligibility?: string; footer?: string; message: string } };
    expect(j.error.eligibility).toBe(RULE);
    expect(j.error.footer).toBe(PRESTART);
  });

  it('MCP supstack_experiment_start: message, footer and rule relayed first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(409, body)),
    );
    const res = await mcpCall('supstack_experiment_start', {
      supplement: 'ashwagandha',
      goal: 'reduce-anxiety',
      answers: { x: 1 },
    });
    expect(res.isError).toBe(true);
    const first = res.content[0]!.text;
    expect(first).toContain(MESSAGE);
    expect(first.indexOf(MESSAGE)).toBeLessThan(first.indexOf(PRESTART));
    expect(first.indexOf(PRESTART)).toBeLessThan(first.indexOf(RULE));
  });
});
