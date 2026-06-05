import { readFileSync, writeFileSync } from 'node:fs';

import { ensureDir, homePath, supstackHome } from './paths';

export const DEFAULT_BASE_URL = 'https://supstack.me/api/v1';

/** Public API base URL. Override with SUPSTACK_API_URL (useful for local dev). */
export function getBaseUrl(): string {
  const fromEnv = process.env.SUPSTACK_API_URL;
  return fromEnv ? fromEnv.replace(/\/$/, '') : DEFAULT_BASE_URL;
}

function configPath(): string {
  return homePath('config.json');
}

interface CliConfig {
  /** Manually-set API key (`supstack auth set-key`). */
  apiKey?: string;
  /** Auto-minted anonymous instant-token (per-key rate limiting, no account). */
  anonKey?: string;
  /** User CLI token from `supstack login` (sent as `Authorization: Bearer`). */
  token?: string;
}

function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

/** Merge a partial config and persist it (0600). */
function writeConfig(patch: Partial<CliConfig>): string {
  ensureDir(supstackHome());
  const next: CliConfig = { ...readConfig(), ...patch };
  // Drop keys explicitly set to undefined so they don't linger as `null`.
  for (const k of Object.keys(next) as (keyof CliConfig)[]) {
    if (next[k] === undefined) delete next[k];
  }
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return configPath();
}

/**
 * The effective API key sent as `X-API-Key` on public reads.
 * Precedence: env var → manually-set key → auto-minted anonymous token.
 */
export function getApiKey(): string | undefined {
  return process.env.SUPSTACK_API_KEY ?? readConfig().apiKey ?? readConfig().anonKey;
}

/** Persist a manually-set API key (used by `supstack auth set-key`). */
export function saveApiKey(apiKey: string): string {
  return writeConfig({ apiKey });
}

/** The auto-minted anonymous instant-token, if one has been issued. */
export function getAnonKey(): string | undefined {
  return readConfig().anonKey;
}

/** Persist the auto-minted anonymous instant-token. */
export function saveAnonKey(anonKey: string): string {
  return writeConfig({ anonKey });
}

/** The user CLI token from `supstack login`, if logged in. */
export function getToken(): string | undefined {
  return process.env.SUPSTACK_TOKEN ?? readConfig().token;
}

/** Persist the user CLI token after a successful login. */
export function saveToken(token: string): string {
  return writeConfig({ token });
}

/** Clear the user CLI token (logout). */
export function clearToken(): string {
  return writeConfig({ token: undefined });
}
