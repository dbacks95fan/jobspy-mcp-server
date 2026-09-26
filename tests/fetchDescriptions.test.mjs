// ABOUTME: Tests the deferred description fetch — stash hits cost no network,
// ABOUTME: misses batch into one subprocess, and an unfetchable posting says so.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchDescriptionsHandler } from '../src/tools/fetch-descriptions.js';
import { createCache } from '../src/descriptionCache.js';

const PROXY = 'http://user:secret@gate.example.com:7000';

function fakeDeps({ rows = [], cache = createCache({ limit: 100 }), proxy = PROXY } = {}) {
  const calls = [];
  return {
    calls,
    cache,
    deps: {
      cache,
      proxy,
      runPython: async (payload) => {
        calls.push(payload);
        return JSON.stringify(rows);
      },
    },
  };
}

test('a stash hit is served with NO subprocess at all', async () => {
  const cache = createCache({ limit: 100 });
  cache.put('a', 'Stashed text for a.');
  const { deps, calls } = fakeDeps({ cache });

  const result = await fetchDescriptionsHandler(
    { jobs: [{ id: 'a', url: 'https://indeed.com/a' }] },
    deps
  );

  assert.equal(calls.length, 0, 'a stash hit must not spawn python');
  assert.equal(result.count, 1);
  assert.equal(result.available, 1);
  assert.equal(result.unavailable, 0);
  assert.equal(result.descriptions[0].source, 'stash');
  assert.equal(result.descriptions[0].description, 'Stashed text for a.');
});

test('misses batch into ONE subprocess call, not one per job', async () => {
  const { deps, calls } = fakeDeps({
    rows: [
      { id: 'a', description: 'From LinkedIn.', source: 'linkedin_fetch' },
      { id: 'b', description: 'From Indeed.', source: 'indeed_fetch' },
    ],
  });

  const result = await fetchDescriptionsHandler(
    {
      jobs: [
        { id: 'a', url: 'https://linkedin.com/jobs/view/a' },
        { id: 'b', url: 'https://indeed.com/b' },
      ],
    },
    deps
  );

  assert.equal(calls.length, 1, 'both misses belong in one batch');
  assert.equal(calls[0].jobs.length, 2);
  assert.equal(result.available, 2);
  assert.deepEqual(
    result.descriptions.map((d) => d.source).sort(),
    ['indeed_fetch', 'linkedin_fetch']
  );
});

test('the payload carries the proxy and never a caller-supplied one', async () => {
  const { deps, calls } = fakeDeps({ rows: [{ id: 'a', description: 'x', source: 'linkedin_fetch' }] });
  await fetchDescriptionsHandler(
    { jobs: [{ id: 'a', url: 'https://linkedin.com/jobs/view/a' }], proxies: 'SMARTPROXY_URL' },
    deps
  );
  assert.equal(calls[0].proxies, PROXY);
});

test('includeMetadata BYPASSES the stash', async () => {
  // The stash holds descriptions only, so a hit would return title/company null.
  const cache = createCache({ limit: 100 });
  cache.put('a', 'Stashed text for a.');
  const { deps, calls } = fakeDeps({
    cache,
    rows: [{ id: 'a', description: 'Fetched.', source: 'indeed_fetch', title: 'PM', company: 'Example' }],
  });

  const result = await fetchDescriptionsHandler(
    { jobs: [{ id: 'a', url: 'https://indeed.com/a' }], includeMetadata: true },
    deps
  );

  assert.equal(calls.length, 1, 'metadata cannot come from the stash');
  assert.equal(result.descriptions[0].title, 'PM');
  assert.equal(result.descriptions[0].company, 'Example');
});

test('an unfetchable posting is `unavailable` WITH a reason, never blank', async () => {
  // A blank description would sail into scoring and the posting would be judged
  // on nothing. "Could not be read" and "has no text" are different facts.
  const { deps } = fakeDeps({
    rows: [{ id: 'a', description: null, source: 'unavailable', error: 'LinkedIn 429' }],
  });
  const result = await fetchDescriptionsHandler(
    { jobs: [{ id: 'a', url: 'https://linkedin.com/jobs/view/a' }] },
    deps
  );
  assert.equal(result.available, 0);
  assert.equal(result.unavailable, 1);
  assert.equal(result.descriptions[0].source, 'unavailable');
  assert.equal(result.descriptions[0].description, null);
  assert.match(result.descriptions[0].error, /429/);
});

test('EVERY requested id comes back, even one the subprocess never mentioned', async () => {
  const { deps } = fakeDeps({ rows: [{ id: 'a', description: 'Only a.', source: 'linkedin_fetch' }] });
  const result = await fetchDescriptionsHandler(
    {
      jobs: [
        { id: 'a', url: 'https://linkedin.com/jobs/view/a' },
        { id: 'b', url: 'https://linkedin.com/jobs/view/b' },
      ],
    },
    deps
  );
  assert.equal(result.count, 2);
  const b = result.descriptions.find((d) => d.id === 'b');
  assert.equal(b.source, 'unavailable');
  assert.ok(b.error, 'silence from the subprocess still needs a stated reason');
});

test('a subprocess failure marks the batch unavailable rather than throwing', async () => {
  const cache = createCache({ limit: 100 });
  cache.put('a', 'Stashed text for a.');
  const result = await fetchDescriptionsHandler(
    { jobs: [{ id: 'a', url: 'https://indeed.com/a' }, { id: 'b', url: 'https://indeed.com/b' }] },
    {
      cache,
      proxy: PROXY,
      runPython: async () => {
        throw new Error('python exploded');
      },
    }
  );
  // The stash hit must survive a failure that has nothing to do with it.
  assert.equal(result.descriptions.find((d) => d.id === 'a').source, 'stash');
  const b = result.descriptions.find((d) => d.id === 'b');
  assert.equal(b.source, 'unavailable');
  assert.match(b.error, /python exploded/);
});

test('a fetched description is stashed so a repeat call is free', async () => {
  const { deps, cache } = fakeDeps({
    rows: [{ id: 'a', description: 'Fetched once.', source: 'linkedin_fetch' }],
  });
  await fetchDescriptionsHandler({ jobs: [{ id: 'a', url: 'https://linkedin.com/jobs/view/a' }] }, deps);
  assert.equal(cache.get('a'), 'Fetched once.');
});

test('without a proxy a MISS is refused but a stash hit is still served', async () => {
  const cache = createCache({ limit: 100 });
  cache.put('a', 'Stashed text for a.');
  const result = await fetchDescriptionsHandler(
    { jobs: [{ id: 'a', url: 'https://indeed.com/a' }, { id: 'b', url: 'https://indeed.com/b' }] },
    { cache, proxy: null, runPython: async () => assert.fail('must not fetch without a proxy') }
  );
  assert.equal(result.descriptions.find((d) => d.id === 'a').source, 'stash');
  const b = result.descriptions.find((d) => d.id === 'b');
  assert.equal(b.source, 'unavailable');
  assert.match(b.error, /proxy/i);
});
