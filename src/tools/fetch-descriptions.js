// ABOUTME: The fetch_descriptions tool — the deferred half of a metadata-first
// ABOUTME: search, serving stash hits free and batching the misses into one call.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { spawn } from 'node:child_process';
import { z } from 'zod';

import logger from '../logger.js';
import { fetchDescriptionsParams } from '../schemas/fetchDescriptionsSchema.js';
import { descriptionCache } from '../descriptionCache.js';
import { resolveProxy } from '../proxyCheck.js';

const PYTHON = process.env.PYTHON_BIN || 'python3';
const FETCH_SCRIPT =
  process.env.JOBSPY_FETCH_SCRIPT || 'jobspy/fetch_descriptions.py';

const MAX_BUFFER = 256 * 1024 * 1024;

export const UNAVAILABLE = 'unavailable';
export const STASH = 'stash';

/**
 * Run the fetch script with the job batch on STDIN.
 *
 * This uses `spawn`, NOT `promisify(execFile)`: the async `execFile` silently
 * ignores its `input` option (that is `execFileSync`/`spawnSync` only), so the
 * child would wait forever on a stdin pipe that never closes. The timeout and
 * the buffer ceiling are therefore enforced here, by hand.
 *
 * @param {object} payload - {jobs, descriptionFormat, includeMetadata, proxies}
 * @param {number} timeout - milliseconds
 * @returns {Promise<string>} stdout
 */
function runPythonProcess(payload, timeout) {
  return new Promise((resolve, reject) => {
    // Argv array, no shell — caller-supplied URLs stay inert data.
    const child = spawn(PYTHON, [FETCH_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let size = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timer);
      if (error) {reject(error);}
      else {resolve(value);}
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`fetch_descriptions timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        child.kill('SIGKILL');
        finish(new Error('fetch_descriptions output exceeded the buffer ceiling'));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) {finish(null, stdout);}
      else {finish(new Error(`fetch_descriptions exited ${code}: ${stderr.slice(-500)}`));}
    });

    // Written explicitly, for the reason in the docstring above.
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/**
 * Handler for the fetch_descriptions MCP tool and for `POST /api/descriptions`.
 *
 * Returns `{count, available, unavailable, descriptions: [...]}` — an object
 * WRAPPING the array, not a bare array. Both callers depend on that shape.
 *
 * @param {object} params
 * @param {object} [deps] - seams for testing: the subprocess, stash and proxy
 */
export async function fetchDescriptionsHandler(params, deps = {}) {
  const {
    runPython = runPythonProcess,
    cache = descriptionCache,
    proxy = resolveProxy(),
  } = deps;

  if (params && params.proxies !== null && params.proxies !== undefined && params.proxies !== '') {
    logger.warn(
      'Ignoring caller-supplied `proxies`: the server owns the proxy. ' +
        'Remove it from the call site.',
    );
  }

  const cleaned = { ...(params || {}) };
  delete cleaned.proxies;
  const validated = z.object(fetchDescriptionsParams).parse(cleaned);

  /** @type {Map<string, object>} */
  const results = new Map();
  const misses = [];

  for (const job of validated.jobs) {
    // includeMetadata bypasses the stash: it holds descriptions only, so a hit
    // would hand back title and company as null.
    const stashed = validated.includeMetadata ? undefined : cache.get(job.id);
    if (stashed) {
      results.set(job.id, {
        id: job.id,
        description: stashed,
        source: STASH,
        error: null,
        title: '',
        company: '',
      });
    } else {
      misses.push(job);
    }
  }

  if (misses.length > 0 && !proxy) {
    // Refused per posting rather than thrown, so the stash hits in the same
    // batch still come back.
    for (const job of misses) {
      results.set(job.id, {
        id: job.id,
        description: null,
        source: UNAVAILABLE,
        error:
          'No usable proxy (SMARTPROXY_URL); refusing to fetch direct from ' +
          'this IP.',
        title: '',
        company: '',
      });
    }
  } else if (misses.length > 0) {
    logger.info('Fetching descriptions', {
      misses: misses.length,
      servedFromStash: results.size,
    });
    try {
      const stdout = await runPython(
        {
          jobs: misses,
          descriptionFormat: validated.descriptionFormat,
          includeMetadata: validated.includeMetadata,
          proxies: proxy,
        },
        validated.timeout,
      );
      const rows = JSON.parse(stdout);
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.id) {continue;}
        const description = row.description || null;
        results.set(row.id, {
          id: row.id,
          description,
          source: description ? row.source || 'linkedin_fetch' : UNAVAILABLE,
          error: row.error || null,
          title: row.title || '',
          company: row.company || '',
        });
        // Stash it so a repeat call — a catch-up run, a tailor request for a
        // posting already in a digest — costs no network.
        if (description) {cache.put(row.id, description);}
      }
    } catch (error) {
      // A transport or subprocess failure is not evidence about the postings.
      logger.error('fetch_descriptions subprocess failed', { error: error.message });
      for (const job of misses) {
        if (results.has(job.id)) {continue;}
        results.set(job.id, {
          id: job.id,
          description: null,
          source: UNAVAILABLE,
          error: `${error.message}`.slice(0, 300),
          title: '',
          company: '',
        });
      }
    }
  }

  // Anything the subprocess never mentioned. Silence is not an answer, so it
  // gets an explicit reason rather than being absent from the response.
  for (const job of validated.jobs) {
    if (results.has(job.id)) {continue;}
    results.set(job.id, {
      id: job.id,
      description: null,
      source: UNAVAILABLE,
      error: 'no entry returned by the fetcher',
      title: '',
      company: '',
    });
  }

  const descriptions = validated.jobs.map((job) => results.get(job.id));
  const available = descriptions.filter((row) => row.description).length;
  return {
    count: descriptions.length,
    available,
    unavailable: descriptions.length - available,
    descriptions,
  };
}

export const fetchDescriptionsTool = (server) =>
  server.tool(
    'fetch_descriptions',
    'Retrieve full job descriptions for postings returned by a metadata-only search',
    fetchDescriptionsParams,
    async (params) => {
      try {
        const result = await fetchDescriptionsHandler(params);
        return {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        logger.error('Error in fetch_descriptions handler', { error: error.message });
        return {
          isError: true,
          error: { message: error.message, code: 'INTERNAL_SERVER_ERROR' },
        };
      }
    },
  );
