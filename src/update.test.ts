import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkForUpdate, isNewerVersion } from './update';
import { VERSION } from './version';

let home: string;
let savedCI: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-update-'));
  process.env.SUPSTACK_HOME = home;
  // The check is a no-op in CI / when opted out; clear those so the logic runs.
  savedCI = process.env.CI;
  delete process.env.CI;
  delete process.env.NO_UPDATE_NOTIFIER;
  delete process.env.SUPSTACK_NO_UPDATE_CHECK;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  if (savedCI !== undefined) process.env.CI = savedCI;
  rmSync(home, { recursive: true, force: true });
});

function bumpPatch(v: string): string {
  const [a = 0, b = 0, c = 0] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

function registryRes(version: string): Response {
  return { json: async () => ({ version }) } as unknown as Response;
}

describe('isNewerVersion', () => {
  it('compares semver-ish versions and ignores pre-release', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.2.0-beta.1', '0.1.0')).toBe(true);
  });
});

describe('checkForUpdate', () => {
  it('nudges when the registry reports a newer version', async () => {
    const newer = bumpPatch(VERSION);
    const fetchImpl = vi.fn().mockResolvedValue(registryRes(newer));
    const writes: string[] = [];
    const out = await checkForUpdate({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 2_000_000_000_000,
      write: (s) => writes.push(s),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(out).toContain(newer);
    expect(writes.join('')).toContain('Update available');
  });

  it('is silent when already up to date', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(registryRes(VERSION));
    const out = await checkForUpdate({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 2_000_000_000_000,
      write: () => undefined,
    });
    expect(out).toBeNull();
  });

  it('opts out via SUPSTACK_NO_UPDATE_CHECK without any network call', async () => {
    process.env.SUPSTACK_NO_UPDATE_CHECK = '1';
    const fetchImpl = vi.fn();
    const out = await checkForUpdate({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throttles network calls to once per day, nudging from cache in between', async () => {
    const newer = bumpPatch(VERSION);
    const fetchImpl = vi.fn().mockResolvedValue(registryRes(newer));
    await checkForUpdate({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 2_000_000_000_000,
      write: () => undefined,
    });
    const writes: string[] = [];
    const out = await checkForUpdate({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 2_000_000_000_000 + 1000, // 1s later → within the 24h throttle
      write: (s) => writes.push(s),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not re-fetched
    expect(out).toContain(newer); // still nudged, from the cached value
  });
});
