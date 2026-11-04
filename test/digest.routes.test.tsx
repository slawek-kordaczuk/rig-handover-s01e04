import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { RigConfig } from '../src/config.js';
import type { DigestRow } from '../src/digest/types.js';

const night = '2026-10-28';
const fixtureRunsDir = fileURLToPath(new URL('../runs/', import.meta.url));

const populatedNight = [
  { at: '2026-10-28T00:00:00+01:00', job: 'zeta', status: 'ok', owner: 'zoe' },
  { at: '2026-10-28T00:01:00+01:00', job: 'alpha', status: 'ok', owner: null },
  { at: '2026-10-28T00:02:00+01:00', job: 'alpha', status: 'retry', owner: null, error: 'retry one' },
  { at: '2026-10-28T00:03:00+01:00', job: 'alpha', status: 'retry', owner: null, error: 'retry two' },
  { at: '2026-10-28T00:04:00+01:00', job: 'beta', status: 'fail', owner: 'bea', error: 'exit code 1' },
  { at: '2026-10-28T00:05:00+01:00', job: 'alpha', status: 'retry', owner: null, error: 'retry three' },
] as const;

const expectedRows: DigestRow[] = [
  {
    job: 'alpha',
    owner: null,
    runs: 4,
    retries: 3,
    lastStatus: 'retry',
    lastError: 'retry three',
    firstAt: '2026-10-28T00:01:00+01:00',
    lastAt: '2026-10-28T00:05:00+01:00',
  },
  {
    job: 'beta',
    owner: 'bea',
    runs: 1,
    retries: 0,
    lastStatus: 'fail',
    lastError: 'exit code 1',
    firstAt: '2026-10-28T00:04:00+01:00',
    lastAt: '2026-10-28T00:04:00+01:00',
  },
  {
    job: 'zeta',
    owner: 'zoe',
    runs: 1,
    retries: 0,
    lastStatus: 'ok',
    lastError: null,
    firstAt: '2026-10-28T00:00:00+01:00',
    lastAt: '2026-10-28T00:00:00+01:00',
  },
];

let tempRoot: string;
let runsDir: string;
let config: RigConfig;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'rig-digest-routes-'));
  runsDir = join(tempRoot, 'runs');
  await mkdir(runsDir);
  config = {
    adapter: 'shim',
    installed: '2026-10-29T14:06:00+01:00',
    beatEverySeconds: 60,
    runsDir,
  };
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function snapshotFiles(directory: string) {
  const names = (await readdir(directory)).sort();
  return Promise.all(
    names.map(async (name) => ({ name, contents: await readFile(join(directory, name), 'utf8') })),
  );
}

async function requestWithoutWriting(path: string) {
  const [tempRunsBefore, fixtureRunsBefore] = await Promise.all([
    snapshotFiles(runsDir),
    snapshotFiles(fixtureRunsDir),
  ]);

  const response = await createApp(config).request(path);

  const [tempRunsAfter, fixtureRunsAfter] = await Promise.all([
    snapshotFiles(runsDir),
    snapshotFiles(fixtureRunsDir),
  ]);
  expect(tempRunsAfter).toEqual(tempRunsBefore);
  expect(fixtureRunsAfter).toEqual(fixtureRunsBefore);

  return response;
}

async function writeNight(contents: string) {
  await writeFile(join(runsDir, `${night}.jsonl`), contents, 'utf8');
}

function jsonLines(records: readonly object[]) {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('GET /digest/:night', () => {
  it('renders rows sorted by job and marks repeated retries and failures', async () => {
    await writeNight(jsonLines(populatedNight));

    const response = await requestWithoutWriting(`/digest/${night}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    const tableRows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
    const displayedJobs = tableRows.flatMap((row) => {
      const job = ['alpha', 'beta', 'zeta'].find((name) => row.includes(name));
      return job === undefined ? [] : [job];
    });
    expect(displayedJobs).toEqual(['alpha', 'beta', 'zeta']);

    expect(tableRows.find((row) => row.includes('alpha'))).toContain('warn');
    expect(tableRows.find((row) => row.includes('beta'))).toContain('warn');
    expect(tableRows.find((row) => row.includes('zeta'))).not.toContain('warn');
  });

  it('returns 404 when the night file is missing', async () => {
    const response = await requestWithoutWriting(`/digest/${night}`);

    expect(response.status).toBe(404);
  });

  it('renders “nothing ran” for a valid empty file', async () => {
    await writeNight('');

    const response = await requestWithoutWriting(`/digest/${night}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('nothing ran');
  });

  it('renders valid records when the file also contains a malformed line', async () => {
    const validRecord = {
      at: '2026-10-28T01:00:00+01:00',
      job: 'kept-job',
      status: 'ok',
      owner: 'operator',
    };
    await writeNight(`${jsonLines([validRecord])}\nnot valid JSON`);

    const response = await requestWithoutWriting(`/digest/${night}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('kept-job');
  });
});

describe('GET /api/digest/:night', () => {
  it('returns the digest rows as sorted JSON', async () => {
    await writeNight(jsonLines(populatedNight));

    const response = await requestWithoutWriting(`/api/digest/${night}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await response.json()) as DigestRow[]).toEqual(expectedRows);
  });

  it('returns 404 when the night file is missing', async () => {
    const response = await requestWithoutWriting(`/api/digest/${night}`);

    expect(response.status).toBe(404);
  });

  it('returns an empty array for a valid empty file', async () => {
    await writeNight('');

    const response = await requestWithoutWriting(`/api/digest/${night}`);

    expect(response.status).toBe(200);
    expect((await response.json()) as DigestRow[]).toEqual([]);
  });

  it('returns valid rows when the file also contains a malformed line', async () => {
    const validRecord = {
      at: '2026-10-28T01:00:00+01:00',
      job: 'kept-job',
      status: 'ok',
      owner: 'operator',
    };
    const expected: DigestRow[] = [
      {
        job: 'kept-job',
        owner: 'operator',
        runs: 1,
        retries: 0,
        lastStatus: 'ok',
        lastError: null,
        firstAt: '2026-10-28T01:00:00+01:00',
        lastAt: '2026-10-28T01:00:00+01:00',
      },
    ];
    await writeNight(`${jsonLines([validRecord])}\nnot valid JSON`);

    const response = await requestWithoutWriting(`/api/digest/${night}`);

    expect(response.status).toBe(200);
    expect((await response.json()) as DigestRow[]).toEqual(expected);
  });
});
