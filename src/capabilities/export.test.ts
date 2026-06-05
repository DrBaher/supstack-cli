import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addToStack } from '../storage';
import { exportStack } from './export';

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supstack-export-'));
  process.env.SUPSTACK_HOME = home;
});

afterEach(() => {
  delete process.env.SUPSTACK_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('export capability', () => {
  it('renders an empty-stack markdown doc when nothing is saved', async () => {
    const result = await exportStack.handler({ format: 'md' });
    expect(result.items).toEqual([]);
    expect(exportStack.format.text(result)).toContain('Your stack is empty');
  });

  it('fetches saved slugs and renders markdown', async () => {
    addToStack('magnesium');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRes({
          data: {
            slug: 'magnesium',
            name: 'Magnesium',
            shortDescription: 'Essential mineral.',
            evidence: { score: 8.5 },
            dosage: { recommended: '200-400mg' },
            safety: { overallRating: 'high' },
          },
        }),
      ),
    );

    const result = await exportStack.handler({ format: 'md' });
    const md = exportStack.format.text(result);

    expect(result.items).toHaveLength(1);
    expect(md).toContain('## Magnesium');
    expect(md).toContain('**Dose:** 200-400mg');
    expect(md).toContain('**Evidence:** 8.5/10');
  });
});
