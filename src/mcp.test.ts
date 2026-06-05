import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildMcpServer, formatToolError } from './mcp';
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
  it('exposes every capability as a tool with an object input schema', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(capabilities.map((c) => c.mcp.toolName).sort());
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
