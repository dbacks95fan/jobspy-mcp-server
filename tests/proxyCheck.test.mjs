// ABOUTME: Tests that the server owns the proxy and never leaks its credential.
// ABOUTME: A caller-supplied proxy is the bug this module exists to make impossible.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProxy, maskProxy } from '../src/proxyCheck.js';

test('the proxy comes from the environment, not from the caller', () => {
  const url = 'http://user:secret@gate.example.com:7000';
  assert.equal(resolveProxy({ SMARTPROXY_URL: url }), url);
});

test('a blank or whitespace-only value counts as absent', () => {
  assert.equal(resolveProxy({ SMARTPROXY_URL: '' }), null);
  assert.equal(resolveProxy({ SMARTPROXY_URL: '   ' }), null);
  assert.equal(resolveProxy({}), null);
});

test('an unsubstituted placeholder is REFUSED, not passed through', () => {
  // On 2026-09-13 the literal string "SMARTPROXY_URL" reached JobSpy and lost
  // 179 postings to an outage that never happened. A value that is not a URL is
  // a misconfiguration, and it has to fail before 39 searches start.
  for (const bad of ['SMARTPROXY_URL', '${SMARTPROXY_URL}', 'changeme', 'gate.example.com']) {
    assert.throws(
      () => resolveProxy({ SMARTPROXY_URL: bad }),
      /proxy/i,
      `expected ${bad} to be refused`
    );
  }
});

test('the mask keeps the host and hides the credential', () => {
  const masked = maskProxy('http://user:secret@gate.example.com:7000');
  assert.ok(masked.includes('gate.example.com'), 'host should stay readable');
  assert.ok(!masked.includes('secret'), 'password must not appear');
  assert.ok(!masked.includes('user'), 'username must not appear');
});

test('masking a value with no credential still returns something printable', () => {
  assert.equal(maskProxy('http://gate.example.com:7000'), 'http://gate.example.com:7000');
  assert.equal(maskProxy(null), '(none)');
});
