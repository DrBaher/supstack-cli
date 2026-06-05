import { capabilities } from './registry';

/** Non-capability top-level commands (not in the registry). */
const EXTRA_COMMANDS = ['login', 'logout', 'whoami', 'mcp', 'auth', 'cache', 'completion', 'help'];

/** Every top-level command name, derived from the registry so it can't drift. */
export function commandNames(): string[] {
  return [...capabilities.map((c) => c.cli.command), ...EXTRA_COMMANDS];
}

export type Shell = 'bash' | 'zsh' | 'fish';

export function isShell(value: string): value is Shell {
  return value === 'bash' || value === 'zsh' || value === 'fish';
}

/**
 * Emit a shell completion script that completes the top-level subcommands.
 * Generated from the live command list, so adding a capability updates
 * completions automatically once the user regenerates the script.
 *
 *   bash:  supstack completion bash >> ~/.bashrc
 *   zsh:   supstack completion zsh  > "${fpath[1]}/_supstack"
 *   fish:  supstack completion fish > ~/.config/fish/completions/supstack.fish
 */
export function completionScript(shell: Shell): string {
  const names = commandNames().join(' ');
  if (shell === 'bash') {
    return `# supstack bash completion
_supstack_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") )
  fi
}
complete -F _supstack_completions supstack
`;
  }
  if (shell === 'zsh') {
    return `#compdef supstack
# supstack zsh completion
_supstack() {
  local -a _cmds
  _cmds=(${names})
  if (( CURRENT == 2 )); then
    _describe 'supstack command' _cmds
  fi
}
_supstack "$@"
`;
  }
  // fish
  return commandNames()
    .map((n) => `complete -c supstack -n "__fish_use_subcommand" -a "${n}"`)
    .join('\n')
    .concat('\n');
}
