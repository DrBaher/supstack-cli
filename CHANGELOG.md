# Changelog

All notable changes to `@supstack/cli` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — Hardening release

### Added

- **`--timeout <seconds>`** global flag (and `SUPSTACK_TIMEOUT`) to tune the
  per-request deadline.
- **`-q, --quiet`** global flag to silence the update notice.
- **`supstack completion <bash|zsh|fish>`** — prints a shell completion script.
  The command list is generated from the capability registry, so it can't drift.
- **Update notice** — a once-a-day, time-boxed "newer version available" nudge
  with zero new dependencies. Silent for non-TTY, `--json`, `--quiet`, `mcp`,
  CI, and opt-out via `SUPSTACK_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER`.

### Fixed

- **Request timeout** — `fetch` had no timeout; a hung connection could block
  the CLI (and an MCP agent's tool call) indefinitely. Each attempt now runs
  under a 20s abort deadline and is retried like a network error.
- **Cache-key identity** — cache keys now fold in an identity segment (`anon`
  vs a one-way key fingerprint) so anonymous and per-key responses can never
  share a slot. Prevents cross-account cache bleed once authenticated responses
  exist.
- **`Retry-After`** — now honours both the delay-seconds and HTTP-date forms
  per RFC 7231.
- **MCP errors** — invalid tool arguments return a readable
  `Invalid arguments: <path>: <message>` instead of a raw `ZodError` JSON blob.

### Changed

- **Bounded response cache** — the on-disk cache is capped; the oldest entries
  are pruned on write so it can't grow without limit.
- **Directory permissions** — `~/.supstack` (and subdirectories) are created
  `0700`; existing `0755` directories are repaired best-effort. The API-key file
  was already `0600`.
- **Engines** — minimum Node bumped to `>=20` (Node 18 is end-of-life). CI now
  tests on Node 20, 22, and 24.

### Infrastructure

- Releases are published from CI with **npm provenance** (verifiable supply-chain
  attestation) on a `v*` tag.

## [0.1.0] — Initial public release

- Evidence-based supplement intelligence as a CLI and an MCP server, built on one
  capability registry so both surfaces stay in sync. Thin client over the public,
  read-only SupStack API (no account required).
- Capabilities: `research`, `search`, `compare`, `studies`, `interactions`
  (`--pathway`), `stack` (local), `export`, `define` — plus an stdio MCP server
  exposing the same eight as tools, and `auth` / `cache` maintenance commands.

[0.2.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.1.0
