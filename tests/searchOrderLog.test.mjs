// ABOUTME: Tests the search-order log — the ground truth for tuning, one JSON
// ABOUTME: line per search recording the ORDER a board returned its job ids in.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSearchOrderLog } from '../src/searchOrderLog.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'search-order-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readRows(dir) {
  const sub = join(dir, 'search-order');
  const files = readdirSync(sub);
  assert.equal(files.length, 1, `expected one daily file, got ${files.join(', ')}`);
  assert.match(files[0], /^search-order-\d{4}-\d{2}-\d{2}\.jsonl$/);
  return readFileSync(join(sub, files[0]), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('one search appends one line carrying the ordered ids', () => {
  withDir((dir) => {
    const log = createSearchOrderLog({ dir });
    log.append({
      site: 'linkedin',
      searchTerm: 'director of engineering',
      location: 'remote',
      resultsWanted: 100,
      jobs: [{ id: 'c' }, { id: 'a' }, { id: 'b' }],
    });
    const [row] = readRows(dir);
    assert.equal(row.site, 'linkedin');
    assert.equal(row.searchTerm, 'director of engineering');
    assert.equal(row.location, 'remote');
    assert.equal(row.resultsWanted, 100);
    assert.equal(row.count, 3);
    // Position is the whole point; sorting or de-duping here would void every
    // position-based conclusion drawn from this file.
    assert.deepEqual(row.ids, ['c', 'a', 'b']);
    assert.ok(row.ts, 'a row needs a timestamp');
  });
});

test('the log carries IDS ONLY — never a description or a salary', () => {
  // It stays small (~90KB/run) and carries nothing sensitive, which is what
  // makes it safe to keep every run's copy on disk.
  withDir((dir) => {
    const log = createSearchOrderLog({ dir });
    log.append({
      site: 'indeed',
      searchTerm: 'engineering manager',
      location: 'remote',
      resultsWanted: 50,
      jobs: [{ id: 'x', description: 'a very long description', minAmount: 200000 }],
    });
    const raw = JSON.stringify(readRows(dir));
    assert.ok(!raw.includes('very long description'));
    assert.ok(!raw.includes('200000'));
  });
});

test('appends accumulate rather than overwrite', () => {
  withDir((dir) => {
    const log = createSearchOrderLog({ dir });
    for (const term of ['one', 'two', 'three']) {
      log.append({ site: 'linkedin', searchTerm: term, location: 'remote', resultsWanted: 10, jobs: [] });
    }
    const rows = readRows(dir);
    assert.deepEqual(rows.map((r) => r.searchTerm), ['one', 'two', 'three']);
  });
});

test('a zero-row search is still recorded', () => {
  // A search that ran and found nothing, and a search that never ran, are
  // different facts — `sweep_searches` tells them apart by this row's absence.
  withDir((dir) => {
    const log = createSearchOrderLog({ dir });
    log.append({ site: 'linkedin', searchTerm: 'nothing', location: 'remote', resultsWanted: 10, jobs: [] });
    const [row] = readRows(dir);
    assert.equal(row.count, 0);
    assert.deepEqual(row.ids, []);
  });
});

test('a logging failure never throws into the search path', () => {
  // The search has already been paid for by the time this runs.
  const log = createSearchOrderLog({ dir: '\0invalid' });
  assert.doesNotThrow(() => log.append({
    site: 'linkedin', searchTerm: 'x', location: 'remote', resultsWanted: 1, jobs: [{ id: 'a' }],
  }));
});
