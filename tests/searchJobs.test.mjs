// ABOUTME: Tests the search handler's argv building, server-owned proxy, the
// ABOUTME: metadata-first stash, and the response-size safety net.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchJobsHandler, buildCommandArgs } from '../src/tools/search-jobs.js';
import { createCache } from '../src/descriptionCache.js';

const PROXY = 'http://user:secret@gate.example.com:7000';

function fakeDeps(jobs, { proxy = PROXY } = {}) {
  const calls = [];
  const cache = createCache({ limit: 100 });
  return {
    calls,
    cache,
    deps: {
      cache,
      proxy,
      orderLog: { append: (row) => calls.push({ kind: 'log', row }) },
      runSearch: async (args) => {
        calls.push({ kind: 'search', args });
        return JSON.stringify(jobs);
      },
    },
  };
}

const job = (id, extra = {}) => ({
  id,
  site: 'indeed',
  title: 'Product Manager',
  company: 'Example',
  job_url: `https://example.com/${id}`,
  description: `Description for ${id}`,
  date_posted: '2026-09-20',
  ...extra,
});

test('args go as a literal argv array, never a shell string', async () => {
  // This was an unauthenticated RCE before it was fixed. A caller-supplied
  // string has to stay inert data.
  const args = buildCommandArgs(
    { siteNames: 'indeed', searchTerm: 'pm; rm -rf /', location: 'remote', format: 'json' },
    PROXY
  );
  assert.ok(Array.isArray(args));
  assert.ok(args.includes('pm; rm -rf /'), 'the term is one argv element, unquoted');
  for (const arg of args) {
    assert.equal(typeof arg, 'string');
    assert.ok(!arg.includes('"'), `argv element should carry no added quoting: ${arg}`);
  }
});

test('the proxy is injected unconditionally from the server side', async () => {
  const { deps, calls } = fakeDeps([job('a')]);
  await searchJobsHandler({ siteNames: 'indeed', searchTerm: 'pm' }, deps);
  const search = calls.find((c) => c.kind === 'search');
  const at = search.args.indexOf('--proxies');
  assert.notEqual(at, -1, 'every job-board call must carry the proxy');
  assert.equal(search.args[at + 1], PROXY);
});

test('a caller-supplied `proxies` is IGNORED, not honored and not rejected', async () => {
  // Twelve call sites were passing one when this changed; rejecting would have
  // broken all of them on rebuild for no gain, since the value is never read.
  const { deps, calls } = fakeDeps([job('a')]);
  const result = await searchJobsHandler(
    { siteNames: 'indeed', searchTerm: 'pm', proxies: 'SMARTPROXY_URL' },
    deps
  );
  assert.equal(result.count, 1);
  const search = calls.find((c) => c.kind === 'search');
  assert.ok(!search.args.includes('SMARTPROXY_URL'), 'the placeholder must never reach JobSpy');
  assert.equal(search.args[search.args.indexOf('--proxies') + 1], PROXY);
});

test('without a proxy the search is refused rather than run direct', async () => {
  // browser.py measured Indeed's Cloudflare admitting this host 0 of 5 times
  // direct. Unproxied is a blocked path, not a degraded one.
  const { deps, calls } = fakeDeps([job('a')], { proxy: null });
  await assert.rejects(
    () => searchJobsHandler({ siteNames: 'indeed', searchTerm: 'pm' }, deps),
    /proxy/i
  );
  assert.equal(calls.filter((c) => c.kind === 'search').length, 0);
});

test('keys are camelCased and datePosted becomes ISO 8601', async () => {
  const { deps } = fakeDeps([job('a')]);
  const result = await searchJobsHandler({ siteNames: 'indeed', searchTerm: 'pm' }, deps);
  assert.equal(result.jobs[0].jobUrl, 'https://example.com/a');
  assert.match(result.jobs[0].datePosted, /^2026-09-20T/);
});

test('metadataOnly strips the description and stashes it', async () => {
  const { deps, cache } = fakeDeps([job('a'), job('b')]);
  const result = await searchJobsHandler(
    { siteNames: 'indeed', searchTerm: 'pm', metadataOnly: true },
    deps
  );
  assert.equal(result.count, 2);
  for (const row of result.jobs) {
    assert.ok(!('description' in row) || row.description == null);
  }
  assert.equal(cache.get('a'), 'Description for a');
  assert.equal(cache.get('b'), 'Description for b');
});

test('without metadataOnly the description stays in the response', async () => {
  const { deps } = fakeDeps([job('a')]);
  const result = await searchJobsHandler({ siteNames: 'indeed', searchTerm: 'pm' }, deps);
  assert.equal(result.jobs[0].description, 'Description for a');
});

test('the search-order log records what the board returned, before trimming', async () => {
  const jobs = Array.from({ length: 250 }, (_, i) => job(`j${i}`));
  const { deps, calls } = fakeDeps(jobs);
  await searchJobsHandler(
    { siteNames: 'linkedin', searchTerm: 'pm', location: 'remote', resultsWanted: 250, maxResponseChars: 500 },
    deps
  );
  const logged = calls.find((c) => c.kind === 'log').row;
  assert.equal(logged.jobs.length, 250, 'positions must reflect the source, not the response');
  assert.equal(logged.site, 'linkedin');
  assert.equal(logged.resultsWanted, 250);
});

test('maxResponseChars trims and REPORTS rather than silently truncating', async () => {
  const jobs = Array.from({ length: 250 }, (_, i) => job(`j${i}`));
  const { deps } = fakeDeps(jobs);
  const result = await searchJobsHandler(
    { siteNames: 'indeed', searchTerm: 'pm', maxResponseChars: 5000 },
    deps
  );
  assert.equal(result.totalFound, 250);
  assert.ok(result.trimmedToFit, 'the caller has to be told');
  assert.ok(result.omittedForSize > 0);
  assert.equal(result.jobs.length + result.omittedForSize, 250);
  assert.ok(JSON.stringify(result.jobs).length <= 5000);
});

test('maxResponseChars of 0 disables the net', async () => {
  const jobs = Array.from({ length: 120 }, (_, i) => job(`j${i}`));
  const { deps } = fakeDeps(jobs);
  const result = await searchJobsHandler({ siteNames: 'indeed', searchTerm: 'pm' }, deps);
  assert.equal(result.jobs.length, 120);
  assert.ok(!result.trimmedToFit);
});

test('an unparseable location does not lose the whole search', async () => {
  // JobSpy aborts the ENTIRE scrape on one unparseable country, which is fatal
  // at high volume; jobspy/main.py patches that. Here: a row missing an id must
  // not take the others down.
  const { deps } = fakeDeps([job('a'), { ...job('b'), id: null }]);
  const result = await searchJobsHandler({ siteNames: 'indeed', searchTerm: 'pm', metadataOnly: true }, deps);
  assert.equal(result.count, 2);
});
