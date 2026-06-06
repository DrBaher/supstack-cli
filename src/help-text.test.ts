import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { attachExamples, EXAMPLES, examplesBlock, SUBCOMMANDS } from './help-text';
import { capabilities } from './registry';

describe('help-text', () => {
  it('examplesBlock is empty for no examples and rendered otherwise', () => {
    expect(examplesBlock(undefined)).toBe('');
    expect(examplesBlock([])).toBe('');
    const block = examplesBlock(['supstack search ashwagandha']);
    expect(block).toContain('Examples:');
    expect(block).toContain('supstack search ashwagandha');
  });

  it('every registry command has an examples entry', () => {
    for (const cap of capabilities) {
      expect(EXAMPLES[cap.cli.command], `missing examples for ${cap.cli.command}`).toBeTruthy();
    }
  });

  it('attachExamples appends the block to a command help', () => {
    let captured = '';
    const cmd = new Command('search');
    cmd.configureOutput({ writeOut: (s) => (captured += s) });
    attachExamples(cmd, 'search');
    cmd.outputHelp();
    expect(captured).toContain('supstack search --goal deep-sleep');
  });

  it('attachExamples is a no-op for an unknown key', () => {
    const cmd = new Command('nope');
    const before = cmd.helpInformation();
    attachExamples(cmd, 'nope');
    expect(cmd.helpInformation()).toBe(before);
  });

  it('SUBCOMMANDS covers the multiplexed + grouped commands', () => {
    expect(SUBCOMMANDS.stack).toEqual(['add', 'remove', 'list', 'pull', 'push', 'sync']);
    expect(SUBCOMMANDS.track).toContain('adherence');
    expect(SUBCOMMANDS.experiments).toContain('show');
    expect(SUBCOMMANDS.completion).toContain('refresh');
  });
});
