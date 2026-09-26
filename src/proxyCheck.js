// ABOUTME: Resolves the residential proxy from the SERVER's own environment and
// ABOUTME: masks its credential for logging; callers never supply a proxy.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.

// Why the server owns this rather than taking it as a parameter: a parameter is
// a thing a caller can get wrong, and validating the value does not remove that
// class of bug. On 2026-09-13 a caller sent the literal string "SMARTPROXY_URL"
// and 179 postings were lost to an "outage" that never happened — every
// LinkedIn fetch failing while every Indeed one succeeded from the stash reads
// exactly like a board outage, and is not one. There is now no way to express an
// unproxied job-board request.

const PLACEHOLDERS = new Set([
  'smartproxy_url',
  '${smartproxy_url}',
  '$smartproxy_url',
  'changeme',
  'todo',
  'none',
]);

/**
 * The proxy URL this server sends every job-board request through.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} the URL, or null when none is configured
 * @throws {Error} when a value is present but is not a usable proxy URL
 */
export function resolveProxy(env = process.env) {
  const raw = (env.SMARTPROXY_URL || '').trim();
  if (!raw) {return null;}

  if (PLACEHOLDERS.has(raw.toLowerCase())) {
    throw new Error(
      `SMARTPROXY_URL is an unsubstituted placeholder (${raw}). Refusing to ` +
        'treat it as a proxy — this is the 2026-09-13 failure mode.',
    );
  }

  // A bare hostname is the other shape of the same mistake: JobSpy would take
  // it, fail every request, and report it as the board's fault.
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `SMARTPROXY_URL is not a URL (${maskProxy(raw)}). Expected ` +
        'scheme://user:pass@host:port.',
    );
  }
  if (!/^https?:$|^socks\d?:$/.test(parsed.protocol) || !parsed.hostname) {
    throw new Error(
      `SMARTPROXY_URL has no usable scheme or host (${maskProxy(raw)}).`,
    );
  }
  return raw;
}

/**
 * A printable form of a proxy URL with the credential removed. Every log line
 * that mentions the proxy goes through this — the URL carries a `user:pass`, and
 * it used to reach the session transcript, the runner log and Anthropic's event
 * store by way of the agent's instruction.
 *
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function maskProxy(url) {
  if (!url) {return '(none)';}
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) {return url;}
    parsed.username = '***';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Unparseable: say so without echoing a value that may hold a credential.
    return '(unparseable proxy value)';
  }
}
