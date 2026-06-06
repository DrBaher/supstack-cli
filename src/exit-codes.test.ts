import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { NotLoggedInError } from './cloud-stack';
import { EXIT, exitCodeFor } from './exit-codes';
import { ApiError } from './http';

const zodErr = (): unknown => {
  try {
    z.object({ age: z.number() }).parse({ age: 'nope' });
  } catch (e) {
    return e;
  }
};

describe('exitCodeFor', () => {
  it('maps NotLoggedInError → AUTH', () => {
    expect(exitCodeFor(new NotLoggedInError())).toBe(EXIT.AUTH);
  });

  it('maps ZodError → INVALID_INPUT', () => {
    expect(exitCodeFor(zodErr())).toBe(EXIT.INVALID_INPUT);
  });

  it('maps ApiError statuses to their codes', () => {
    expect(exitCodeFor(new ApiError(0, 'timeout'))).toBe(EXIT.NETWORK);
    expect(exitCodeFor(new ApiError(400, 'bad'))).toBe(EXIT.INVALID_INPUT);
    expect(exitCodeFor(new ApiError(422, 'bad'))).toBe(EXIT.INVALID_INPUT);
    expect(exitCodeFor(new ApiError(401, 'unauth'))).toBe(EXIT.AUTH);
    expect(exitCodeFor(new ApiError(403, 'forbidden'))).toBe(EXIT.AUTH);
    expect(exitCodeFor(new ApiError(404, 'missing'))).toBe(EXIT.NOT_FOUND);
    expect(exitCodeFor(new ApiError(429, 'slow down'))).toBe(EXIT.RATE_LIMIT);
    expect(exitCodeFor(new ApiError(500, 'server'))).toBe(EXIT.ERROR);
    expect(exitCodeFor(new ApiError(503, 'down'))).toBe(EXIT.ERROR);
  });

  it('maps an unknown error → ERROR', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(EXIT.ERROR);
    expect(exitCodeFor('a string')).toBe(EXIT.ERROR);
  });

  it('maps commander usage errors → INVALID_INPUT, matching ZodError', () => {
    for (const code of [
      'commander.unknownCommand',
      'commander.unknownOption',
      'commander.missingArgument',
      'commander.excessArguments',
    ]) {
      expect(exitCodeFor(new CommanderError(1, code, 'bad usage'))).toBe(EXIT.INVALID_INPUT);
    }
  });

  it('preserves commander help/version exit codes (not treated as errors)', () => {
    expect(exitCodeFor(new CommanderError(0, 'commander.helpDisplayed', ''))).toBe(EXIT.OK);
    expect(exitCodeFor(new CommanderError(0, 'commander.version', ''))).toBe(EXIT.OK);
    // bare `supstack` with no command shows help and exits 1 — preserved.
    expect(exitCodeFor(new CommanderError(1, 'commander.help', ''))).toBe(EXIT.ERROR);
  });
});
