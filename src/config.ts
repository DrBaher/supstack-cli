import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { homePath, supstackHome } from './paths';

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
  apiKey?: string;
}

function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

/**
 * Resolve the API key. Precedence: env var → ~/.supstack/config.json.
 * The API is soft-gated (anonymous calls are allowed at 60/min per IP), so a
 * key is OPTIONAL today — but the client sends it whenever present so the same
 * code path works once per-key rate limits / Phase 2 auth land.
 */
export function getApiKey(): string | undefined {
  return process.env.SUPSTACK_API_KEY ?? readConfig().apiKey;
}

/** Persist an API key to ~/.supstack/config.json (used by `supstack auth set-key`). */
export function saveApiKey(apiKey: string): string {
  mkdirSync(supstackHome(), { recursive: true });
  const next: CliConfig = { ...readConfig(), apiKey };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return configPath();
}
