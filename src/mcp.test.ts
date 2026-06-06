import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildMcpServer, formatToolError } from './mcp';
import { AUTHED_TOOLS } from './mcp-authed';
import { capabilities } from './registry';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([buildMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe('mcp server', () => {
  it('exposes every capability + authed tool with an object input schema', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    const names = new Set(tools.map((t) => t.name));
    for (const c of capabilities) expect(names.has(c.mcp.toolName)).toBe(true);
    for (const t of AUTHED_TOOLS) expect(names.has(t.name)).toBe(true);
    expect(tools.length).toBe(capabilities.length + AUTHED_TOOLS.length);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description && t.description.length).toBeTruthy();
    }
    await client.close();
  });

  it('routes a tool call through the capability handler', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonRes({ data: { term: 'Adaptogen', definition: 'Helps resist stress.', aliases: [] } }),
        ),
    );
    const client = await connectedClient();

    const res = (await client.callTool({ name: 'supstack_define', arguments: { term: 'adaptogen' } })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };

    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain('Adaptogen');
    await client.close();
  });

  it('returns an error result for an unknown tool', async () => {
    const client = await connectedClient();
    const res = (await client.callTool({ name: 'supstack_nope', arguments: {} })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('returns a readable validation error for bad arguments (not raw JSON)', async () => {
    const client = await connectedClient();
    // `define` requires a `term` string; omit it to trigger a ZodError.
    const res = (await client.callTool({ name: 'supstack_define', arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('Invalid arguments:');
    expect(res.content[0]?.text).toContain('term');
    await client.close();
  });
});

describe('mcp authed tools', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'supstack-mcp-'));
    process.env.SUPSTACK_HOME = home; // isolate: never read the dev's real token
    delete process.env.SUPSTACK_TOKEN;
  });
  afterEach(() => {
    delete process.env.SUPSTACK_HOME;
    delete process.env.SUPSTACK_TOKEN;
    rmSync(home, { recursive: true, force: true });
  });

  it('mutating tools are flagged readOnlyHint:false; reads true', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('supstack_profile_set')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('supstack_track_log')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('supstack_recommend')?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it('routes an authed tool through its handler when a token is present', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: {
            days: 7,
            scheduledDoses: 21,
            takenDoses: 18,
            rate: 0.86,
            streak: 3,
            stackSize: 3,
            perSupplement: [],
          },
        }),
      ),
    );
    const client = await connectedClient();
    const res = (await client.callTool({ name: 'supstack_track_adherence', arguments: { days: 7 } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain('"rate": 0.86');
    await client.close();
  });

  it('returns a clear not-logged-in error when no token is present', async () => {
    const client = await connectedClient();
    const res = (await client.callTool({ name: 'supstack_recommend', arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/log in|login/i);
    await client.close();
  });

  it('flattens a bad-argument ZodError (experiments_get needs an id)', async () => {
    const client = await connectedClient();
    const res = (await client.callTool({ name: 'supstack_experiments_get', arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('Invalid arguments:');
    expect(res.content[0]?.text).toContain('id');
    await client.close();
  });

  it('profile_set rejects an empty patch', async () => {
    process.env.SUPSTACK_TOKEN = 'sct_live_x';
    const client = await connectedClient();
    const res = (await client.callTool({ name: 'supstack_profile_set', arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/at least one field/i);
    await client.close();
  });
});

describe('formatToolError', () => {
  it('flattens a ZodError into path: message pairs', () => {
    const schema = z.object({ term: z.string() });
    const err = schema.safeParse({}).error;
    const formatted = formatToolError(err);
    expect(formatted).toMatch(/^Invalid arguments: /);
    expect(formatted).toContain('term:');
  });

  it('passes through a plain Error message', () => {
    expect(formatToolError(new Error('boom'))).toBe('boom');
  });
});
