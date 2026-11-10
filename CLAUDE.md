# SupStack CLI — conventions

`@supstack/cli` is a thin, public-API client that ships as **both** a terminal CLI
and an **MCP server**, from one capability registry.

**Two tiers, and only one of them goes through the registry.**

- **Phase 1 — anonymous read.** The 10 capabilities in `src/registry.ts` (`research`,
  `search`, `compare`, `studies`, `interactions`, `stack`, `rate`, `goals`, `export`,
  `define`) hit the public read API. No auth required — it is soft-gated, and
  anonymous calls get 60/min/IP (the CLI mints an anonymous key on first run via
  `POST /v1/auth/anon-token`, which raises that to 120/min).
- **Phase 2 — authenticated, and it is live.** `login` / `logout` / `whoami`,
  `profile`, `track` + `adherence`, cloud `stack`, `recommend` and the
  `experiments` group (`list`, `show`, `start`, `check-in`, `abandon`, `protocol`)
  call `/api/v1/me/*` with `Authorization: Bearer sct_live_…`, obtained through the
  device-code flow (`src/auth.ts` → `/v1/auth/device/start|token`, approved by the
  user at `supstack.me/activate`). These are wired directly in `src/cli.ts` and
  `src/mcp-authed.ts`, **not** as registry capabilities, because they need a token
  the registry's `apiGet()` path does not carry. That split is deliberate; it is
  also the reason `registry.ts`'s "the single source of truth for what the CLI and
  the MCP server can do" comment is true only of the anonymous tier.

Endpoint contracts for both tiers live in the app repo's `API.md` and
`src/lib/openapi-spec.ts`, which `tests/data/documented-surface-parity.test.ts`
holds to the filesystem.

## The capability pattern (the one rule that matters)

Every command is a `Capability` (`src/capability.ts`) defined **once** and exposed
through every surface. Never write a command handler directly against commander or
the MCP SDK — define a capability and register it.

```
inputSchema (zod)  →  handler(input)  →  format.{ text, json }
        │                   │                    │
   CLI arg parsing     hits public API      CLI output + MCP result
   + MCP JSON Schema
```

- `src/registry.ts` — the array of capabilities. Add one line → it appears in the
  CLI (`src/cli.ts` iterates it) **and** the MCP server (`src/mcp.ts` iterates it).
  The two surfaces are generated from the same list, so they cannot drift.
- `src/capabilities/define.ts` — the **reference implementation**. Copy its shape
  for `research`, `search`, `compare`, `studies`, `stack`, `interactions`, `export`.

## To add a capability

1. Create `src/capabilities/<name>.ts` exporting a `defineCapability({ ... })`.
2. Validate input with a zod object schema (positional args + options both map into it).
3. Fetch via `apiGet()` (`src/http.ts`) — never call `fetch` directly. It handles
   the 60/min rate limit: retry + backoff on 429/5xx, respects `Retry-After`, and
   attaches `X-API-Key` when a key is configured.
4. Write `format.text` (human) and `format.json` (machine / MCP).
5. Add it to `src/registry.ts`.
6. Add a `*.test.ts` next to it (mock `fetch`; do not hit the network in unit tests).

## Architectural decisions

- **CLI hits the public API at `https://supstack.me/api/v1`, never Supabase directly.**
  Keeps the CLI a true API client (the platform thesis) and lets API changes
  propagate to all clients. Override the base URL with `SUPSTACK_API_URL`.
- **Response schemas live in the CLI as zod, not imported from the app's `src/`.**
  This is a deliberate deviation from the original handoff's "reuse types from src/".
  The API's JSON contract (`{ data: ... }` envelopes) is the source of truth for a
  *publishable* client; importing the Next.js app's internal types into a standalone
  npm package would couple the package to app internals and complicate its build.
  Each capability owns a small zod schema for the response shape it consumes. The
  same schema feeds the MCP tool's JSON Schema, so there's still one definition.
- **Two credentials, not one.** `supstack auth set-key` / `SUPSTACK_API_KEY` sets an
  `X-API-Key` for the anonymous read tier (rate limit only). `supstack login` obtains a
  per-user CLI token (`sct_live_…`) sent as `Authorization: Bearer` — that is what the
  `/me/*` commands use, and an API key does **not** substitute for it.
- **MCP is first-class.** `@modelcontextprotocol/sdk` is a regular dependency.
  `src/mcp.ts` uses the low-level `Server` and generates each tool's JSON Schema
  from the capability's zod schema via zod v4's native
  `z.toJSONSchema(schema, { io: 'input' })` — so MCP tools never drift from the CLI
  and we don't couple to the SDK's own zod version. `buildMcpServer()` is unit-tested
  with an in-memory transport; `cli.ts` lazy-imports `mcp.ts` so non-`mcp` commands
  don't pay its startup cost.

## Commands

| Script | Purpose |
|---|---|
| `npm run build` | tsup → `dist/index.js` (ESM, node18, shebang) |
| `npm test` | vitest (unit; mocked fetch) |
| `npm run type-check` | `tsc --noEmit` |
| `npm run dev` | tsup watch |

## Style

Matches the parent repo: 2-space indent, single quotes, semicolons, named exports.
`strict` + `noUncheckedIndexedAccess` are on.
