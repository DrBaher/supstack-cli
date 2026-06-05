import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { errorToJson } from './cli';
import { ApiError } from './http';

describe('errorToJson (--json error output)', () => {
  it('formats a ZodError as invalid_input with structured issues', () => {
    const err = z.object({ term: z.string() }).safeParse({}).error!;
    const out = errorToJson(err);
    expect(out.error.type).toBe('invalid_input');
    const issues = out.error.issues as { path: string; message: string }[];
    expect(issues[0]?.path).toBe('term');
    expect(typeof issues[0]?.message).toBe('string');
  });

  it('formats an ApiError with its status', () => {
    expect(errorToJson(new ApiError(404, 'No definition found')).error).toMatchObject({
      type: 'api_error',
      status: 404,
      message: 'No definition found',
    });
  });

  it('formats a generic error', () => {
    expect(errorToJson(new Error('boom')).error).toMatchObject({ type: 'error', message: 'boom' });
  });
});
