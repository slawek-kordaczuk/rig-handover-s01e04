import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';

const fixtureRunsDir = fileURLToPath(new URL('../runs', import.meta.url));

describe('readNight', () => {
  it('reads the sample night as five jobs and one bad line', () => {
    const { rows, badLines } = readNight(fixtureRunsDir, '2026-10-28');

    expect(rows).toHaveLength(5);
    expect(badLines).toBe(1);
  });

  it('aggregates retries and keeps the last error and original time offsets', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-reader-'));
    const records = [
      {
        at: '2026-10-28T23:59:00-04:00',
        job: 'recovered-job',
        status: 'retry',
        owner: null,
        error: 'temporary failure',
      },
      {
        at: '2026-10-29T00:01:00+02:00',
        job: 'recovered-job',
        status: 'ok',
        owner: null,
      },
    ];

    try {
      writeFileSync(
        join(runsDir, 'edge.jsonl'),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );

      expect(readNight(runsDir, 'edge')).toEqual({
        rows: [
          {
            job: 'recovered-job',
            owner: null,
            runs: 2,
            retries: 1,
            lastStatus: 'ok',
            lastError: 'temporary failure',
            firstAt: '2026-10-28T23:59:00-04:00',
            lastAt: '2026-10-29T00:01:00+02:00',
          },
        ],
        badLines: 0,
      });
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
