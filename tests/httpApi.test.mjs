// ABOUTME: Tests the HTTP surface — the bearer gate, /health, and the two
// ABOUTME: non-MCP shortcuts the runner and the tailor agent call directly.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/httpApi.js';

const TOKEN = 'test-token';

function start(overrides = {}) {
  const app = createApp({
    authToken: TOKEN,
    searchJobs: async () => ({ count: 1, jobs: [{ id: 'a' }] }),
    fetchDescriptions: async () => ({
      count: 1,
      available: 1,
      unavailable: 0,
      descriptions: [{ id: 'a', description: 'text', source: 'stash' }],
    }),
    ...overrides,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const post = (url, body, token) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

test('/health needs no token — it is what a deploy check calls', async () => {
  const ctx = await start();
  try {
    const resp = await fetch(ctx.url('/health'));
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).status, 'ok');
  } finally {
    await ctx.close();
  }
});

test('/api refuses an unauthenticated call', async () => {
  // This route reaches the search handler with no MCP framing, so it is exactly
  // as powerful as the tool. It was an unauthenticated RCE before it was fixed.
  const ctx = await start();
  try {
    const resp = await post(ctx.url('/api'), { searchTerm: 'pm' });
    assert.equal(resp.status, 401);
  } finally {
    await ctx.close();
  }
});

test('/api refuses a WRONG token', async () => {
  const ctx = await start();
  try {
    const resp = await post(ctx.url('/api'), { searchTerm: 'pm' }, 'nope');
    assert.equal(resp.status, 401);
  } finally {
    await ctx.close();
  }
});

test('/api runs the search when the token is right', async () => {
  const ctx = await start();
  try {
    const resp = await post(ctx.url('/api'), { searchTerm: 'pm' }, TOKEN);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).count, 1);
  } finally {
    await ctx.close();
  }
});

test('/api/descriptions is gated too and returns the wrapped shape', async () => {
  const ctx = await start();
  try {
    assert.equal((await post(ctx.url('/api/descriptions'), { jobs: [] })).status, 401);
    const resp = await post(
      ctx.url('/api/descriptions'),
      { jobs: [{ id: 'a', url: 'https://indeed.com/a' }] },
      TOKEN
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    // An object WRAPPING the array, not a bare array. Both callers parse this.
    assert.ok(Array.isArray(body.descriptions));
    assert.equal(body.count, 1);
  } finally {
    await ctx.close();
  }
});

test('a handler failure is a 500 with a reason, not a hang', async () => {
  // A wedged request is the silent shape this whole pipeline keeps being bitten
  // by: neither finished nor failed, and the only symptom is a missing digest.
  const ctx = await start({
    searchJobs: async () => {
      throw new Error('proxy refused');
    },
  });
  try {
    const resp = await post(ctx.url('/api'), { searchTerm: 'pm' }, TOKEN);
    assert.equal(resp.status, 500);
    assert.match((await resp.json()).error, /proxy refused/);
  } finally {
    await ctx.close();
  }
});

test('a server with NO token configured refuses every gated call', async () => {
  // Failing open would put an unauthenticated search endpoint on a host that is
  // reachable through the reverse proxy. An absent token is a misconfiguration,
  // and the safe reading of it is "nobody is allowed", not "everybody is".
  const ctx = await start({ authToken: '' });
  try {
    assert.equal((await post(ctx.url('/api'), { searchTerm: 'pm' })).status, 401);
    assert.equal((await post(ctx.url('/api'), { searchTerm: 'pm' }, TOKEN)).status, 401);
  } finally {
    await ctx.close();
  }
});
