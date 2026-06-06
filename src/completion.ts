import { capabilities } from './registry';

/** Non-capability top-level commands (not in the registry). */
const EXTRA_COMMANDS = [
  'login',
  'logout',
  'whoami',
  'profile',
  'recommend',
  'experiments',
  'track',
  'mcp',
  'auth',
  'cache',
  'completion',
  'help',
];

/** Every top-level command name, derived from the registry so it can't drift. */
export function commandNames(): string[] {
  return [...capabilities.map((c) => c.cli.command), ...EXTRA_COMMANDS];
}

export type Shell = 'bash' | 'zsh' | 'fish';

export function isShell(value: string): value is Shell {
  return value === 'bash' || value === 'zsh' || value === 'fish';
}

/**
 * Emit a shell completion script. The scripts are thin forwarders: they hand the
 * typed tokens to `supstack __complete`, which owns ALL completion logic
 * ([complete.ts](complete.ts)) — top-level commands, sub-actions, and dynamic
 * supplement-slug / goal-id values. So completions stay correct as the command
 * grammar evolves, with no need to regenerate the script.
 *
 *   bash:  supstack completion bash >> ~/.bashrc
 *   zsh:   supstack completion zsh  > "${fpath[1]}/_supstack"
 *   fish:  supstack completion fish > ~/.config/fish/completions/supstack.fish
 */
export function completionScript(shell: Shell): string {
  if (shell === 'bash') {
    // NB: a \`read\` loop (not \`IFS=$'\\n'; COMPREPLY=( $(...) )\`) — on macOS's
    // bash 3.2 a non-default IFS corrupts the quoted "\${COMP_WORDS[@]:...}"
    // array-slice expansion, mangling the forwarded tokens. Here IFS is scoped
    // to \`read\` only, so the slice expands under the default IFS.
    return `# supstack bash completion
_supstack_completions() {
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [ -n "$line" ] && COMPREPLY+=( "$line" )
  done < <(supstack __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
}
complete -F _supstack_completions supstack
`;
  }
  if (shell === 'zsh') {
    return `#compdef supstack
# supstack zsh completion
_supstack() {
  local -a completions
  completions=( \${(f)"$(supstack __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)"} )
  compadd -- $completions
}
compdef _supstack supstack
`;
  }
  // fish — one dynamic rule; node decides what (if anything) to offer.
  return `complete -c supstack -f -a '(supstack __complete (commandline -opc)[2..-1] (commandline -ct))'\n`;
}
