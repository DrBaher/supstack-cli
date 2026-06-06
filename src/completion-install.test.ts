import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { completionScriptPath, installCompletion, uninstallCompletion } from './completion-install';

let home: string;
let supHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-home-'));
  supHome = mkdtempSync(join(tmpdir(), 'supstack-state-'));
  prevHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() reads $HOME on posix
  process.env.SUPSTACK_HOME = supHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.SUPSTACK_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(supHome, { recursive: true, force: true });
});

describe('completion install (bash/zsh)', () => {
  it('writes the script and wires a marked block into the rc file', () => {
    const r = installCompletion('zsh');
    expect(existsSync(r.scriptPath)).toBe(true);
    expect(readFileSync(r.scriptPath, 'utf8')).toContain('supstack __complete');
    expect(r.rcPath).toBe(join(home, '.zshrc'));
    const rc = readFileSync(r.rcPath as string, 'utf8');
    expect(rc).toContain('# >>> supstack completion >>>');
    expect(rc).toContain(`source "${r.scriptPath}"`);
    expect(r.alreadyWired).toBe(false);
  });

  it('is idempotent — a second install does not duplicate the block', () => {
    installCompletion('bash');
    const r2 = installCompletion('bash');
    expect(r2.alreadyWired).toBe(true);
    const rc = readFileSync(join(home, '.bashrc'), 'utf8');
    expect(rc.match(/# >>> supstack completion >>>/g)?.length).toBe(1);
  });

  it('preserves existing rc content', () => {
    const rcPath = join(home, '.bashrc');
    writeFileSync(rcPath, 'export FOO=1\n');
    installCompletion('bash');
    const rc = readFileSync(rcPath, 'utf8');
    expect(rc).toContain('export FOO=1');
    expect(rc).toContain('supstack completion');
  });

  it('uninstall removes the script and the rc block but keeps other lines', () => {
    const rcPath = join(home, '.zshrc');
    writeFileSync(rcPath, 'export KEEP=1\n');
    const { scriptPath } = installCompletion('zsh');
    const { removed } = uninstallCompletion('zsh');
    expect(removed.length).toBe(2);
    expect(existsSync(scriptPath)).toBe(false);
    const rc = readFileSync(rcPath, 'utf8');
    expect(rc).toContain('export KEEP=1');
    expect(rc).not.toContain('supstack completion');
  });

  it('uninstall is a no-op when nothing is installed', () => {
    expect(uninstallCompletion('bash').removed).toEqual([]);
  });
});

describe('completion install (fish)', () => {
  it('writes to the fish completions dir and needs no rc edit', () => {
    const r = installCompletion('fish');
    expect(r.rcPath).toBeNull();
    expect(r.scriptPath).toBe(completionScriptPath('fish'));
    expect(r.scriptPath).toContain(join('.config', 'fish', 'completions', 'supstack.fish'));
    expect(readFileSync(r.scriptPath, 'utf8')).toContain('supstack __complete');
  });
});
