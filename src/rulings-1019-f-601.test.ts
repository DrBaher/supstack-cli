/**
 * Pharmacist ruling 601 (19 October 2026, owner-approved "yes apply all
 * verbatim") on the CLI and the MCP server: her W601 "Report a symptom or
 * safety concern" on `show` and `list` for a running or paused experiment,
 * `experiments report` printing her display line before the questions and the
 * safety action FIRST after a report, the report never described as a
 * check-in, and the MCP tool relaying the action first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runExperimentReport,
  runExperimentShow,
  runExperimentsList,
  W601_REPORT_ACTION,
  W601_REPORT_EMERGENCY_LINE,
} from './experiments';
import { buildMcpServer } from './mcp';

const ID = '8b03297e-0000-4000-8000-000000000601';
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
  home = mkdtempSync(join(tmpdir(), 'supstack-1019f601-'));
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
  progress: { completed: 1, expected: 4 },
  safetyAction: null,
  responses: [],
  protocol: null,
  ...(status === 'active' || status === 'paused'
    ? {
        safetyReport: {
          action: W601_REPORT_ACTION,
          emergencyLine: W601_REPORT_EMERGENCY_LINE,
          questions: [
            {
              id: 'red-flag-signs',
              text: 'Any warning signs now?',
              type: 'choice',
              category: 'safety',
              required: true,
              options: [
                { value: 'none', label: 'None' },
                { value: 'now', label: 'Yes, now' },
              ],
            },
          ],
        },
      }
    : {}),
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

describe('601 on the CLI', () => {
  it('show: her label and display line on a running and a paused experiment, none on an ended one', async () => {
    for (const status of ['active', 'paused']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json(200, { data: detail(status) })),
      );
      const r = await capture(() => runExperimentShow(ID, false));
      expect(r.error).toBeNull();
      expect(plain(r.out)).toContain(W601_REPORT_ACTION);
      expect(plain(r.out)).toContain(W601_REPORT_EMERGENCY_LINE);
      expect(plain(r.out)).toMatch(/supstack experiments report 8b03297e/);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { data: detail('completed') })),
    );
    const done = await capture(() => runExperimentShow(ID, false));
    expect(plain(done.out)).not.toContain(W601_REPORT_ACTION);
  });

  it('list: her line under a list with a running experiment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { data: [{ ...detail('active'), verdict: null }] })),
    );
    const r = await capture(() => runExperimentsList(undefined, false));
    expect(plain(r.out)).toContain(W601_REPORT_ACTION);
  });

  it('report with no answers: the display line BEFORE the questions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { data: detail('paused') })),
    );
    const r = await capture(() => runExperimentReport(ID, [], false));
    const t = plain(r.out);
    expect(t.indexOf(W601_REPORT_EMERGENCY_LINE)).toBeGreaterThanOrEqual(0);
    expect(t.indexOf(W601_REPORT_EMERGENCY_LINE)).toBeLessThan(t.indexOf('red-flag-signs'));
  });

  it('a report: the action first, then the report recorded, the check-ins said unchanged, never "check-in recorded"', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/safety-report')
        ? json(201, {
            data: {
              reportNumber: 2,
              safetyAction: ACTION,
              paused: true,
              statusHold: false,
              checkInsCompleted: 1,
              emergencyLine: W601_REPORT_EMERGENCY_LINE,
            },
          })
        : json(200, { data: detail('active') }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await capture(() => runExperimentReport(ID, ['red-flag-signs=now'], false));
    expect(r.error).toBeNull();
    const t = plain(r.out);
    expect(t.indexOf('EMERGENCY INSTRUCTION')).toBeLessThan(t.indexOf('Safety report 2 recorded'));
    expect(t).toMatch(/check-ins unchanged: 1/);
    expect(t).not.toMatch(/Check-in #\d+ recorded/);
    const posted = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/safety-report'));
    expect(posted).toBeTruthy();
  });
});

describe('601 on the MCP server', () => {
  it('supstack_experiment_report_safety relays the action first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(201, {
          data: {
            reportNumber: 1,
            safetyAction: ACTION,
            paused: true,
            statusHold: false,
            checkInsCompleted: 0,
          },
        }),
      ),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([buildMcpServer().connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const t = tools.tools.find((x) => x.name === 'supstack_experiment_report_safety');
    expect(t?.description).toMatch(/Report a symptom or safety concern/);
    const res = (await client.callTool({
      name: 'supstack_experiment_report_safety',
      arguments: { id: ID, answers: { 'red-flag-signs': 'now' } },
    })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toMatch(/^Safety instructions/);
    expect(res.content[0]!.text).toContain('EMERGENCY INSTRUCTION');
  });
});
