# Changelog

All notable changes to `@supstack/cli` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] — `interactions --medication`: supplement × drug checks

### Added

- **`supstack interactions <supplements...> --medication <drug>`** — checks **each**
  supplement against a medication and lists the matching drug-interaction warnings
  with clinical severity (red = major/severe/contraindicated). Answers "does my
  stack interact with lisinopril?". Works with a single supplement too.
- The `supstack_interactions` MCP tool gains the same `medication` mode (agents can
  now do supplement×drug safety checks).

## [0.14.0] — One-step completion install + Homebrew

### Added

- **`supstack completion install`** — detects your shell from `$SHELL`, writes the
  completion script, and wires your rc file with a single marked, idempotent
  `source` block (fish needs no rc edit — it auto-loads). **`completion uninstall`**
  removes it cleanly, preserving the rest of your rc file.

### Distribution

- **Homebrew** — `brew install drbaher/supstack/supstack` (tap
  [DrBaher/homebrew-supstack](https://github.com/DrBaher/homebrew-supstack)). The
  formula is bumped automatically on each release.

## [0.13.0] — `goals`: discover goal ids

### Added

- **`supstack goals [query] [--category <id>]`** — list the health goal ids (with
  names, grouped by category) that `rate` and `recommend` expect. Filter by a
  free-text query or a category.
- **MCP tool `supstack_goals`** — lets an agent map a user's plain-language goal
  ("sleep better") to the correct id before calling `supstack_rate_stack` /
  `supstack_recommend`. The `rate` tool description now points agents to it.

## [0.12.0] — Clearer `rate` output: what the grade means + inferred-goal flag

### Changed

- **`rate` now explains the grade.** The headline reads e.g. `Stack grade: D ·
  41/100 · weak match for your goals` instead of a bare `D (41/100)` — so the
  letter and number are meaningful on their own. (User feedback: an agent relayed
  "41/D" and the meaning was unclear.)
- **Inferred goals are flagged at the score and made actionable.** When goals
  weren't given, the headline says "…match for **inferred** goals", and a `⚠`
  block names the inferred goals and shows how to pass `--goals` for a tailored
  score.
- The grade response now carries `ratingLabel` (Excellent | Strong | Fair | Weak |
  Poor) and a self-contained `summary` sentence. The `supstack_rate_stack` MCP
  tool description now instructs agents to relay the `summary` (not the bare
  score/letter) and to state whether goals were given or inferred.

Backed by the `/api/v1/stack/grade` `ratingLabel`/`summary` fields.

## [0.11.1] — Docs: list `supstack_rate_stack` in the MCP toolset

### Docs

- README's MCP read-only tool list now includes `supstack_rate_stack` (added in
  0.11.0). No code change.

## [0.11.0] — `rate`: grade your stack

### Added

- **`supstack rate [supplements...]`** — grade a stack **A–F** (and 0–100) by how
  well it covers your goals, with a per-goal coverage bar and the gaps. Supplements
  default to your local stack (`--cloud` for your synced stack, or pass slugs
  explicitly). Goals come from `--goals`, else your account goals when signed in,
  else they're inferred from the stack itself.
- **MCP tool `supstack_rate_stack`** — the same grading exposed to agents (pass
  `supplements` and/or `goals`, or omit to grade the local stack / infer goals).
- Shell completion for `rate` — supplement slugs as positionals and goal ids
  after `--goals`.

Backed by the new public `GET /api/v1/stack/grade` endpoint, so the CLI grade
matches the website's StackGradeCard exactly (one shared coverage algorithm).

## [0.10.1] — Consistent exit codes for CLI-usage errors

### Fixed

- Commander's own usage errors (unknown command, unknown/missing option, missing
  or excess arguments) now exit with **`6` (invalid input)** — the same code as a
  schema validation error — instead of a generic `1`. `--help` / `--version` still
  exit `0`, and bare `supstack` (no command) still shows help and exits `1`. Closes
  a gap where a script branching on exit codes saw `6` for some bad-input cases and
  `1` for others.

## [0.10.0] — Authenticated MCP tools + colour polish

### Added

- **Account-scoped MCP tools.** The MCP server now exposes the authenticated
  operations to agents, alongside the 8 read-only tools: `supstack_recommend`,
  `supstack_profile_get` / `supstack_profile_set`, `supstack_experiments_list` /
  `supstack_experiments_get`, `supstack_track_log`, `supstack_track_adherence`
  (cloud stack pull/push/sync was already reachable via `supstack_stack`). They
  require the user to be signed in (`supstack login` / `SUPSTACK_TOKEN`) and
  return a clear "not logged in" error otherwise. Mutating tools (`profile_set`,
  `track_log`) carry `readOnlyHint: false`.
- **`--color` / `--no-color` flags** (in addition to `NO_COLOR` / `FORCE_COLOR`)
  to force colour on through a pipe or off in a TTY. Resolved before any output
  and position-independent.
- A **404 hint** in error output pointing at `supstack search` to find valid slugs.

### Changed

- The "good" tier now renders in **green** (aligning with the web app's
  evidence colours): strong evidence (≥8/10) in `search`, positive interactions,
  and ≥90% adherence (overall + per-supplement).

## [0.9.0] — CLI polish: dynamic completion, exit codes, help examples

### Added

- **Dynamic shell completion.** The bash/zsh/fish scripts now forward the typed
  line to a hidden `supstack __complete`, which offers context-aware candidates:
  top-level commands, sub-actions (`stack <TAB>` → `add remove …`), **supplement
  slugs** where a slug is expected (`research`/`compare`/`interactions`/`stack
  add`/`track log`), and **goal ids** after `search --goal`. Slug/goal lists are
  fetched once and cached under `~/.supstack/completion/` (24h TTL).
- **`supstack completion refresh`** — pre-warm / refresh the completion value cache.
- **Semantic exit codes.** Failures now exit with a code by kind: `2` auth, `3`
  not-found, `4` rate-limited, `5` network/timeout, `6` invalid input (`1`
  otherwise). Documented in the README; applied to every command path.
- **Usage examples in `--help`** for the major commands (`search`, `stack`,
  `interactions`, `compare`, `research`, `studies`, `recommend`, `profile set`,
  `track log`, `experiments list`, …).

### Fixed

- Completion scripts are robust on **macOS's bash 3.2**: the bash script reads
  candidates via a `read` loop so a non-default `IFS` can't corrupt the quoted
  `"${COMP_WORDS[@]:…}"` array-slice expansion (a bash 3.2 quirk that previously
  mangled the forwarded tokens).

### Notes

- Completion runs side-effect-free: it never mints/persists an anonymous API key,
  and a cold-cache fetch is bounded (TAB stays responsive; degrades to "no
  suggestions" offline).

## [0.8.2] — Audit-deferred hardening

### Fixed

- **`track adherence` timezone alignment** — the CLI now sends its local calendar
  date (`&today=YYYY-MM-DD`) so the server's adherence window and streak line up
  with the local dates `track log` writes, avoiding a TZ-boundary off-by-one.
- **Adherence bar no longer throws** on a rate slightly above 1.0 (e.g. a
  post-backfill `takenDays` briefly exceeding the window): the filled-cell count
  is clamped to `[0,12]` so `'░'.repeat()` can't get a negative count.
- **Anonymous instant-token mint backs off instead of latching** — a failed mint
  (offline) now retries after a 60s cooldown rather than disabling anon-token
  minting for the life of the process, so a long-lived `mcp` server that regains
  connectivity mints on a later request.

### Internal

- Added formatter tests (`runAdherence`, `runTrackLog`, `runProfileShow`,
  `runExperimentsList`) covering empty/populated/null rendering paths.

## [0.8.1] — Error-handling fix

### Fixed

- Account commands (login/logout/whoami/profile/recommend/experiments/track) now
  route errors through the shared formatter: a clean message + the 401 "run
  supstack login" hint, and — importantly — **machine-readable `{ error }` output
  in `--json` mode** (previously these 7 commands printed a bare line on error,
  bypassing the structured-error contract).
- `experiments show --json` now wraps its object as `{ experiment }` (consistent
  with `experiments list`).

## [0.8.0] — Adherence tracking (Phase 2)

### Added

- **`supstack track log [supplement]`** — log a dose (today/taken by default).
  No supplement = log your whole stack for the day. `--block`, `--date`, `--skip`.
- **`supstack track adherence`** — your adherence rate, current streak, and a
  per-supplement breakdown over the last `--days` (default 30). Implicit-miss:
  un-logged scheduled doses count as missed.

## [0.7.0] — Experiments (read)

### Added

- **`supstack experiments list`** — list your N-of-1 experiments (supplement × goal,
  status, check-in progress, verdict). `-s/--status` to filter, `--json`.
- **`supstack experiments show <id>`** — one experiment in detail: status, verdict
  + summary, and your check-in responses.

## [0.6.0] — Personalized recommendations (Phase 2)

### Added

- **`supstack recommend`** — personalized supplement recommendations computed
  from your **saved goals + cloud stack** (no arguments needed; requires
  `supstack login`). Shows a composite score, the driving goal, evidence, and
  any safety/interaction warnings. `-n/--limit` and `--json` supported.

## [0.5.0] — Profile (Phase 2, Increment C)

### Added

- **`supstack profile`** — view your health profile (age, sex, weight,
  conditions, medications, goals). Requires `supstack login`.
- **`supstack profile set`** — update profile fields:
  `--age`, `--sex`, `--weight`, `--weight-unit`, `--conditions`, `--medications`,
  `--goals` (comma-separated lists). Only the flags you pass change; the rest are
  left as-is. `--json` supported on both.
- **`supstack profile clear`** — delete your health profile.

## [0.4.0] — Cloud stack sync (Phase 2, Increment B)

### Added

- **`supstack stack pull | push | sync`** — sync your supplement stack with your
  account (requires `supstack login`):
  - `pull` — replace the local stack with your account's stack.
  - `push` — make your account's membership match local (keeps existing dosage/
    timing/brand for supplements that stay; drops those not in local).
  - `sync` — additive merge: union of local + cloud, saved to both. **Never drops
    or flattens** — existing cloud metadata (dosage/timing/brand) is preserved.
- Exposed through the MCP `supstack_stack` tool too, so an agent can sync a
  logged-in user's stack.

## [0.3.0] — Accounts (Phase 2, Increment A)

### Added

- **`supstack login`** — sign in to your SupStack account via a device-code flow
  (gh-style): the CLI shows a one-time code, opens the browser to `/activate`,
  and finishes automatically once you approve. The token is stored in
  `~/.supstack/config.json` (`0600`) and sent as `Authorization: Bearer`.
- **`supstack logout`** — revoke this device's token server-side and clear it.
- **`supstack whoami`** — show the signed-in account (`--json` supported).
- **Anonymous instant-token** — on the first read with no key configured, the
  CLI mints an anonymous token and persists it, so reads carry a stable per-key
  identity (better rate limits) with zero friction. Opt out with
  `SUPSTACK_NO_UPDATE_CHECK`'s sibling `SUPSTACK_NO_ANON_TOKEN`.

### Configuration

- `SUPSTACK_TOKEN` — override the stored account token.
- `SUPSTACK_NO_ANON_TOKEN` — disable auto-minting of the anonymous token.

## [0.2.1] — Polish

### Fixed

- **`stack` slug normalization** — `stack add` now lowercases and trims slugs
  (the API rejects non-lowercase slugs with HTTP 400). Previously
  `stack add Magnesium` stored an unusable slug that `export` then silently
  dropped; case variants also created duplicate entries.

### Changed

- **Evidence-score display** — `research`, `search`, and `compare` now show the
  score as `X/10` (matching `export`), instead of a bare, scale-ambiguous number.
- **`--json` errors are machine-readable** — in `--json` mode, failures emit a
  structured `{ "error": { type, message, ... } }` to stderr instead of prose, so
  scripts and agents can parse them. stdout remains the data channel.

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

[0.8.1]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.8.1
[0.8.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.8.0
[0.7.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.7.0
[0.6.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.6.0
[0.5.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.5.0
[0.4.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.4.0
[0.3.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.3.0
[0.2.1]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.2.1
[0.2.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/DrBaher/supstack-cli/releases/tag/v0.1.0
