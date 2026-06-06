import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { completionScript, type Shell } from './completion';
import { ensureDir, homePath } from './paths';

/**
 * One-step completion install/uninstall. Writes the generated script to a stable
 * path and (for bash/zsh) wires a single, marked `source` line into the shell rc
 * file — idempotently, so re-running is safe and the block can be cleanly removed.
 * fish needs no rc edit: its completions directory is auto-loaded.
 */

const MARK_START = '# >>> supstack completion >>>';
const MARK_END = '# <<< supstack completion <<<';

export interface InstallResult {
  scriptPath: string;
  /** The rc file wired (bash/zsh), or null for fish (auto-loaded). */
  rcPath: string | null;
  /** True if it was already wired — nothing changed. */
  alreadyWired: boolean;
  /** How to activate it in the current session. */
  reload: string;
}

function rcFileFor(shell: Shell): string | null {
  if (shell === 'bash') return join(homedir(), '.bashrc');
  if (shell === 'zsh') return join(homedir(), '.zshrc');
  return null; // fish auto-loads from its completions dir
}

export function completionScriptPath(shell: Shell): string {
  if (shell === 'fish') return join(homedir(), '.config', 'fish', 'completions', 'supstack.fish');
  return homePath('completion', `supstack.${shell}`);
}

/** Remove an existing supstack completion block from rc text (idempotent). */
function stripBlock(text: string): string {
  const start = text.indexOf(MARK_START);
  if (start === -1) return text;
  const end = text.indexOf(MARK_END, start);
  if (end === -1) return text;
  const before = text.slice(0, start).replace(/\n+$/, '');
  const after = text.slice(end + MARK_END.length).replace(/^\n+/, '');
  return [before, after].filter(Boolean).join('\n\n') + (after || before ? '\n' : '');
}

export function installCompletion(shell: Shell): InstallResult {
  const scriptPath = completionScriptPath(shell);
  ensureDir(join(scriptPath, '..'));
  writeFileSync(scriptPath, completionScript(shell));

  const rcPath = rcFileFor(shell);
  if (!rcPath) {
    return { scriptPath, rcPath: null, alreadyWired: true, reload: 'Restart fish (or open a new shell).' };
  }

  const sourceLine = `[ -f "${scriptPath}" ] && source "${scriptPath}"`;
  const block = `${MARK_START}\n${sourceLine}\n${MARK_END}\n`;
  const existing = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : '';
  const alreadyWired = existing.includes(sourceLine);
  if (!alreadyWired) {
    const cleaned = stripBlock(existing); // replace any stale block (e.g. moved path)
    const sep = cleaned && !cleaned.endsWith('\n') ? '\n' : '';
    writeFileSync(rcPath, `${cleaned}${sep}${block}`);
  }
  return { scriptPath, rcPath, alreadyWired, reload: `source ${rcPath}` };
}

export function uninstallCompletion(shell: Shell): { removed: string[] } {
  const removed: string[] = [];
  const scriptPath = completionScriptPath(shell);
  if (existsSync(scriptPath)) {
    rmSync(scriptPath, { force: true });
    removed.push(scriptPath);
  }
  const rcPath = rcFileFor(shell);
  if (rcPath && existsSync(rcPath)) {
    const text = readFileSync(rcPath, 'utf8');
    if (text.includes(MARK_START)) {
      writeFileSync(rcPath, stripBlock(text));
      removed.push(`${rcPath} (completion block)`);
    }
  }
  return { removed };
}
