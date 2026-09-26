// ABOUTME: Tests the description stash — the store that keeps the descriptions
// ABOUTME: Indeed hands back free during search so a later fetch costs nothing.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCache } from '../src/descriptionCache.js';

test('a stashed description comes back', () => {
  const cache = createCache({ limit: 10 });
  cache.put('job-1', 'Full remote product role.');
  assert.equal(cache.get('job-1'), 'Full remote product role.');
  assert.equal(cache.size(), 1);
});

test('a miss is undefined, never an empty string', () => {
  const cache = createCache({ limit: 10 });
  // An empty description would sail into scoring and be judged on nothing,
  // so absence has to stay distinguishable from "has no text".
  assert.equal(cache.get('nope'), undefined);
});

test('an empty or missing description is not stashed at all', () => {
  const cache = createCache({ limit: 10 });
  cache.put('job-1', '');
  cache.put('job-2', null);
  cache.put('job-3', undefined);
  assert.equal(cache.size(), 0);
});

test('the cap evicts the OLDEST entry, not the newest', () => {
  // FIFO is the point: a run stashes ~3,000 rows and then fetches the survivors
  // it kept, so the entries most likely to be wanted are the recent ones.
  const cache = createCache({ limit: 3 });
  cache.put('a', 'first');
  cache.put('b', 'second');
  cache.put('c', 'third');
  cache.put('d', 'fourth');
  assert.equal(cache.size(), 3);
  assert.equal(cache.get('a'), undefined, 'oldest should have been evicted');
  assert.equal(cache.get('d'), 'fourth');
});

test('re-stashing a job does not grow the cache or lose its place', () => {
  const cache = createCache({ limit: 2 });
  cache.put('a', 'first');
  cache.put('a', 'first again');
  assert.equal(cache.size(), 1);
  assert.equal(cache.get('a'), 'first again');
});

test('with a cache dir, a description survives a restart', () => {
  // The documented failure of the memory-only stash: search and fetch are two
  // separate calls, and a container recreate between them silently turned every
  // Indeed posting into `unavailable`. Disk spill removes that window.
  const dir = mkdtempSync(join(tmpdir(), 'desc-cache-'));
  try {
    const first = createCache({ limit: 10, dir });
    first.put('job-9', 'Survives a restart.');
    assert.ok(readdirSync(dir).length > 0, 'expected a file on disk');

    const second = createCache({ limit: 10, dir });
    assert.equal(second.get('job-9'), 'Survives a restart.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable cache dir degrades to memory instead of throwing', () => {
  // A search that already cost 45-85s and real proxy traffic must never be lost
  // to a disk problem; the stash is an optimization, not the source of truth.
  const cache = createCache({ limit: 10, dir: '\0invalid' });
  cache.put('job-1', 'still here');
  assert.equal(cache.get('job-1'), 'still here');
});

test('a job id that looks like a path cannot escape the cache dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desc-cache-'));
  try {
    const cache = createCache({ limit: 10, dir });
    cache.put('../../escape', 'nope');
    for (const name of readdirSync(dir)) {
      assert.ok(!name.includes('..'), `unsafe cache filename: ${name}`);
    }
    assert.equal(cache.get('../../escape'), 'nope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
