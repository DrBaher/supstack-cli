import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearToken, getAnonKey, getApiKey, getToken, saveAnonKey, saveApiKey, saveToken } from './config';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-config-'));
  process.env.SUPSTACK_HOME = home;
  delete process.env.SUPSTACK_API_KEY;
  delete process.env.SUPSTACK_TOKEN;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  delete process.env.SUPSTACK_API_KEY;
  delete process.env.SUPSTACK_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('config api-key precedence', () => {
  it('env > manual key > anonymous token', () => {
    expect(getApiKey()).toBeUndefined();
    saveAnonKey('sk_live_anon');
    expect(getApiKey()).toBe('sk_live_anon'); // anon fallback
    saveApiKey('sk_live_manual');
    expect(getApiKey()).toBe('sk_live_manual'); // manual beats anon
    process.env.SUPSTACK_API_KEY = 'sk_live_env';
    expect(getApiKey()).toBe('sk_live_env'); // env beats all
  });
});

describe('config token', () => {
  it('round-trips and clears', () => {
    expect(getToken()).toBeUndefined();
    saveToken('sct_live_x');
    expect(getToken()).toBe('sct_live_x');
    clearToken();
    expect(getToken()).toBeUndefined();
  });

  it('SUPSTACK_TOKEN env overrides stored token', () => {
    saveToken('sct_live_stored');
    process.env.SUPSTACK_TOKEN = 'sct_live_env';
    expect(getToken()).toBe('sct_live_env');
  });

  it('clearing the token leaves keys intact', () => {
    saveAnonKey('sk_live_anon');
    saveApiKey('sk_live_manual');
    saveToken('sct_live_x');
    clearToken();
    expect(getToken()).toBeUndefined();
    expect(getAnonKey()).toBe('sk_live_anon');
    expect(getApiKey()).toBe('sk_live_manual');
  });
});
