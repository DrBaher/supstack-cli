import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import { clearToken, getToken, saveToken } from './config';
import { apiGetAuthed, apiPost } from './http';
import { bold, cyan, dim, yellow } from './output';

// ─── Wire types ──────────────────────────────────────────────────────────

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

interface DevicePoll {
  status?: 'pending' | 'denied' | 'complete';
  access_token?: string;
}

export interface MeData {
  id: string;
  email: string | null;
  displayName: string | null;
  goals: { goalId: string; priority: number | null }[];
}

// ─── Thin network helpers (injectable fetch for tests) ───────────────────

export function startDeviceLogin(fetchImpl?: typeof fetch): Promise<DeviceStart> {
  return apiPost<DeviceStart>(
    '/auth/device/start',
    { device_name: `SupStack CLI on ${hostname()}` },
    { fetchImpl },
  );
}

export function pollDeviceToken(deviceCode: string, fetchImpl?: typeof fetch): Promise<DevicePoll> {
  return apiPost<DevicePoll>('/auth/device/token', { device_code: deviceCode }, { fetchImpl });
}

export async function fetchMe(token: string, fetchImpl?: typeof fetch): Promise<MeData> {
  const res = await apiGetAuthed<{ data: MeData }>('/me', token, { fetchImpl });
  return res.data;
}

export function revokeToken(token: string, fetchImpl?: typeof fetch): Promise<unknown> {
  return apiPost('/auth/logout', undefined, { bearer: token, fetchImpl });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Best-effort: open the verification URL in the user's browser. */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No browser / sandboxed — the printed URL is the fallback.
  }
}

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

// ─── Commands ────────────────────────────────────────────────────────────

/** `supstack login` — device-code flow. */
export async function runLogin(): Promise<void> {
  const start = await startDeviceLogin();

  out();
  out(`  First, copy your one-time code:  ${bold(cyan(start.user_code))}`);
  out();
  out(`  Then open this URL and confirm it:`);
  out(`    ${start.verification_uri_complete}`);
  out();
  out(dim('  Opening your browser… (if it doesn’t open, paste the URL above)'));
  openBrowser(start.verification_uri_complete);
  out(dim('  Waiting for authorization…'));

  const deadline = Date.now() + start.expires_in * 1000;
  const intervalMs = Math.max(1, start.interval) * 1000;

  for (;;) {
    if (Date.now() >= deadline) {
      out();
      out(yellow('  Login timed out.') + ' Run `supstack login` again.');
      process.exitCode = 1;
      return;
    }
    await sleep(intervalMs);

    let poll: DevicePoll;
    try {
      poll = await pollDeviceToken(start.device_code);
    } catch (err) {
      // Expired/invalid device code → stop; transient errors → keep polling.
      const status = (err as { status?: number }).status;
      if (status === 400) {
        out();
        out(yellow('  Login expired.') + ' Run `supstack login` again.');
        process.exitCode = 1;
        return;
      }
      continue;
    }

    if (poll.status === 'pending') continue;
    if (poll.status === 'denied') {
      out();
      out(yellow('  Login was denied.') + ' No device was connected.');
      process.exitCode = 1;
      return;
    }
    if (poll.status === 'complete' && poll.access_token) {
      saveToken(poll.access_token);
      let who = '';
      try {
        const me = await fetchMe(poll.access_token);
        who = me.email ? ` as ${bold(me.email)}` : '';
      } catch {
        // Token saved; whoami is just a nicety.
      }
      out();
      out(`  ${cyan('✓')} Logged in${who}.`);
      return;
    }
  }
}

/** `supstack logout` — revoke the token server-side and clear it locally. */
export async function runLogout(): Promise<void> {
  const token = getToken();
  if (!token) {
    out(dim('Not logged in.'));
    return;
  }
  try {
    await revokeToken(token);
  } catch {
    // Even if the revoke call fails (offline), clear locally.
  }
  clearToken();
  out('Logged out.');
}

/** `supstack whoami` — show the authenticated account. */
export async function runWhoami(asJson: boolean): Promise<void> {
  const token = getToken();
  if (!token) {
    if (asJson) {
      out(JSON.stringify({ loggedIn: false }, null, 2));
    } else {
      out(dim('Not logged in.') + ' Run `supstack login`.');
    }
    process.exitCode = 1;
    return;
  }
  const me = await fetchMe(token);
  if (asJson) {
    out(JSON.stringify({ loggedIn: true, ...me }, null, 2));
    return;
  }
  out(`${bold(me.email ?? me.id)}${me.displayName ? ` (${me.displayName})` : ''}`);
  if (me.goals.length) {
    out(dim(`Goals: ${me.goals.map((g) => g.goalId).join(', ')}`));
  }
}
