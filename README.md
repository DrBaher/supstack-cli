# @supstack/cli

Evidence-based supplement intelligence in your terminal — and an MCP server for AI agents.

A thin client over the public [SupStack API](https://supstack.me/api). Read-only,
no account required. One capability registry powers both the CLI and the MCP server.

> **Status: Phase 2 (accounts) in progress.** All read commands below work, plus
> an MCP server and `login`/`whoami`. Install with `npm install -g @supstack/cli`.

## Install

```bash
npm install -g @supstack/cli   # once published
# or, from source (in this directory):
npm install && npm run build && node dist/index.js define adaptogen
```

## Usage

```bash
supstack research magnesium --protocol       # full evidence summary for one supplement
supstack search --goal deep-sleep -n 5       # search by name or filter
supstack compare magnesium glycine           # 2–3 head-to-head
supstack studies "sleep" --type rct          # research library
supstack interactions caffeine l-theanine --pathway   # interaction check (deep pair analysis)
supstack stack add magnesium                 # local stack (add | remove | list)
supstack stack sync                          # sync local ⇄ your account (login required)
supstack rate --goals deep-sleep,sharpen-focus   # grade your stack A–F by goal coverage
supstack export --format md                  # export your stack
supstack define bioavailability              # glossary lookup
supstack <command> --json                    # machine-readable output on any command
supstack --help
```

### Account (Phase 2)

```bash
supstack login          # sign in via device-code flow (opens the browser to confirm)
supstack whoami         # show the signed-in account
supstack logout         # sign out and revoke this device's token
```

`login` shows a one-time code, opens `https://supstack.me/activate`, and finishes
once you approve in the browser. The token lives in `~/.supstack/config.json`
(`0600`). Reads work fully anonymously — an account unlocks personalized features.

Once logged in, sync your stack with your account:

```bash
supstack stack pull     # local ← your account
supstack stack push     # local → your account (keeps dosage/timing/brand for kept items)
supstack stack sync     # additive merge of both; preserves existing cloud metadata

supstack profile                              # view your health profile
supstack profile set --age 35 --sex male --weight 80 --weight-unit kg
supstack recommend                            # personalized picks from your goals + stack
supstack experiments list                     # your N-of-1 experiments + verdicts
supstack track log                            # log today's stack as taken
supstack track adherence                      # your adherence rate, streak, per-supplement
```

### As an MCP server

```bash
supstack mcp   # stdio MCP server exposing all capabilities as tools
```

This gives an agent the full SupStack toolset. **Read-only** (no account needed):
`supstack_research`, `supstack_search`, `supstack_compare`, `supstack_studies`,
`supstack_interactions`, `supstack_stack`, `supstack_export`, `supstack_define`.

**Account-scoped** tools are also exposed — `supstack_recommend`,
`supstack_profile_get` / `supstack_profile_set`, `supstack_experiments_list` /
`supstack_experiments_get`, `supstack_track_log`, `supstack_track_adherence`
(plus cloud `supstack_stack` pull/push/sync). These require the user to be signed
in (`supstack login`, or a `SUPSTACK_TOKEN`); without a token they return a clear
"not logged in" error rather than failing. Mutating tools (`profile_set`,
`track_log`) are flagged `readOnlyHint: false` for the agent.

**Claude Code** (one command):

```bash
claude mcp add supstack -- supstack mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "supstack": {
      "command": "supstack",
      "args": ["mcp"]
    }
  }
}
```

> Or run it without a global install via `"command": "npx", "args": ["-y", "@supstack/cli", "mcp"]`.
> To use a local checkout, point at the built entrypoint —
> `"command": "node", "args": ["/absolute/path/to/supstack-cli/dist/index.js", "mcp"]` (run `npm run build` first).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SUPSTACK_API_URL` | `https://supstack.me/api/v1` | API base URL (override for local dev) |
| `SUPSTACK_API_KEY` | — | Optional API key (anonymous works at 60/min/IP) |
| `SUPSTACK_CACHE_TTL` | `3600` | Response cache TTL in seconds |
| `SUPSTACK_NO_CACHE` | — | Set to disable the response cache |
| `SUPSTACK_TIMEOUT` | `20` | Per-request timeout in seconds (or use `--timeout`) |
| `SUPSTACK_HOME` | `~/.supstack` | Directory for config, stack, and cache |
| `SUPSTACK_TOKEN` | — | Override the stored account token (from `supstack login`) |
| `SUPSTACK_NO_ANON_TOKEN` | — | Disable auto-minting of the anonymous instant-token |
| `SUPSTACK_NO_UPDATE_CHECK` | — | Disable the "update available" notice (also honours `NO_UPDATE_NOTIFIER`) |
| `NO_COLOR` | — | Disable ANSI colour |
| `FORCE_COLOR` | — | Force ANSI colour on (even when piped) |

Global flags available on any command: `--json`, `--no-cache`, `--timeout <seconds>`, `--color` / `--no-color`, `-q, --quiet`.

`supstack auth set-key <key>` persists a key to `~/.supstack/config.json` (written `0600`).

### Response cache

Read-only API responses are cached under `~/.supstack/cache/` (1-hour TTL by
default) to keep repeat lookups well under the 60/min rate limit. Bypass it per
command with `--no-cache`, or manage it with `supstack cache clear` /
`supstack cache path`. The cache is bounded (oldest entries pruned past a cap).

### Shell completion

Generate a completion script for your shell:

```bash
supstack completion bash >> ~/.bashrc
supstack completion zsh  > "${fpath[1]}/_supstack"
supstack completion fish > ~/.config/fish/completions/supstack.fish
```

Completions are **dynamic** — the script forwards what you've typed to
`supstack __complete`, which offers the right thing for the position:

- top-level commands and sub-actions (`stack <TAB>` → `add remove list pull push sync`)
- **supplement slugs** where a slug is expected (`research <TAB>`, `compare a <TAB>`, `stack add <TAB>`, `track log <TAB>`)
- **goal ids** after `search --goal <TAB>`

Slug/goal lists are fetched once from the API and cached under
`~/.supstack/completion/` (24-hour TTL). Pre-warm or refresh them with:

```bash
supstack completion refresh
```

### Exit codes

Commands exit with a semantic code so scripts and MCP wrappers can branch on the
kind of failure:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Generic error (incl. 5xx) |
| `2` | Auth required/rejected (not logged in, 401, 403) |
| `3` | Not found (404) |
| `4` | Rate limited (429) |
| `5` | Network failure / timeout |
| `6` | Invalid input (bad/missing args or flags, unknown command, schema validation, 400/422) |

## Develop

```bash
npm test            # unit tests (mocked fetch)
npm run type-check  # tsc --noEmit
npm run build       # tsup → dist/
```

See [`CLAUDE.md`](./CLAUDE.md) for the capability pattern and how to add a command.

## License

MIT
