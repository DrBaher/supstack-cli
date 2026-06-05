import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Keep the MCP SDK external so the core CLI builds and runs even when the
  // optional dependency isn't installed (mcp.ts dynamic-imports it).
  external: [/@modelcontextprotocol\/sdk/],
  banner: { js: '#!/usr/bin/env node' },
});
