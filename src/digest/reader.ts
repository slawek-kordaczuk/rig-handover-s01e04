import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, ReadNight } from './types.js';

type RunRecord = {
  at: string;
  job: string;
  status: DigestStatus;
  owner: string | null;
  error?: string;
};

function isDigestStatus(value: unknown): value is DigestStatus {
  return value === 'ok' || value === 'retry' || value === 'fail';
}

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.at === 'string' &&
    typeof record.job === 'string' &&
    isDigestStatus(record.status) &&
    (typeof record.owner === 'string' || record.owner === null) &&
    (record.error === undefined || typeof record.error === 'string')
  );
}

export const readNight: ReadNight = (runsDir, night) => {
  const contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }

  const rowsByJob = new Map<string, DigestRow>();
  let badLines = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }

    if (!isRunRecord(parsed)) {
      badLines += 1;
      continue;
    }

    const record = parsed;
    const row = rowsByJob.get(record.job);
    if (row === undefined) {
      rowsByJob.set(record.job, {
        job: record.job,
        owner: record.owner,
        runs: 1,
        retries: record.status === 'retry' ? 1 : 0,
        lastStatus: record.status,
        lastError: record.error ?? null,
        firstAt: record.at,
        lastAt: record.at,
      });
      continue;
    }

    row.owner = record.owner;
    row.runs += 1;
    if (record.status === 'retry') {
      row.retries += 1;
    }
    row.lastStatus = record.status;
    if (record.error !== undefined) {
      row.lastError = record.error;
    }
    row.lastAt = record.at;
  }

  return { rows: [...rowsByJob.values()], badLines };
};
