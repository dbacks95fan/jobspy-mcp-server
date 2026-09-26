// ABOUTME: Pins the ABSENCE of a `proxies` parameter on both tool schemas.
// ABOUTME: Re-adding one restores the 2026-09-13 bug and nothing else would complain.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchParams } from '../src/schemas/searchParamsSchema.js';
import { fetchDescriptionsParams } from '../src/schemas/fetchDescriptionsSchema.js';

// These two assertions are about ABSENCE. A caller cannot get a parameter wrong
// that does not exist, and no amount of validating a caller-supplied value
// removes that class of bug — which is why the previous fix was the wrong shape.
test('search_jobs has no `proxies` parameter', () => {
  assert.ok(!('proxies' in searchParams));
});

test('fetch_descriptions has no `proxies` parameter', () => {
  assert.ok(!('proxies' in fetchDescriptionsParams));
});

test('search_jobs still accepts the params the runner sends', () => {
  for (const key of [
    'siteNames', 'searchTerm', 'location', 'isRemote', 'resultsWanted',
    'hoursOld', 'metadataOnly', 'maxResponseChars',
  ]) {
    assert.ok(key in searchParams, `missing search param: ${key}`);
  }
});

test('fetch_descriptions accepts the params both callers send', () => {
  for (const key of ['jobs', 'descriptionFormat', 'includeMetadata', 'timeout']) {
    assert.ok(key in fetchDescriptionsParams, `missing fetch param: ${key}`);
  }
});
