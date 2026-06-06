import { describe, expect, it } from 'vitest';

import { commandNames, completionScript, isShell } from './completion';
import { capabilities } from './registry';

describe('completion', () => {
  it('lists every capability command plus the non-registry extras', () => {
    const names = commandNames();
    for (const c of capabilities) expect(names).toContain(c.cli.command);
    expect(names).toEqual(expect.arrayContaining(['mcp', 'auth', 'cache', 'completion']));
  });

  it('emits a recognisable script for each supported shell', () => {
    expect(completionScript('bash')).toContain('complete -F _supstack_completions supstack');
    expect(completionScript('zsh')).toContain('#compdef supstack');
    expect(completionScript('fish')).toContain('complete -c supstack');
  });

  it('every script forwards the typed tokens to `supstack __complete`', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      expect(completionScript(shell)).toContain('supstack __complete');
    }
  });

  it('isShell narrows only supported shells', () => {
    expect(isShell('bash')).toBe(true);
    expect(isShell('zsh')).toBe(true);
    expect(isShell('fish')).toBe(true);
    expect(isShell('powershell')).toBe(false);
  });
});
