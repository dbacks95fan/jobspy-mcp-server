// ABOUTME: The search_jobs tool and its handler — runs JobSpy in-container,
// ABOUTME: stashes descriptions for the deferred fetch, and owns the proxy.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import changeCase from 'change-case-object';

import logger from '../logger.js';
import { searchParams } from '../schemas/searchParamsSchema.js';
import { descriptionCache } from '../descriptionCache.js';
import { searchOrderLog } from '../searchOrderLog.js';
import { resolveProxy, maskProxy } from '../proxyCheck.js';

const execFileAsync = promisify(execFile);

// Python + the python-jobspy library are installed in THIS image (see the root
// Dockerfile), so there is no docker-in-docker, no /var/run/docker.sock mount
// and no separate jobspy image needed at runtime.
const PYTHON = process.env.PYTHON_BIN || 'python3';
const SEARCH_SCRIPT = process.env.JOBSPY_SEARCH_SCRIPT || 'jobspy/main.py';

// One search can return thousands of rows of JSON; the default 1MB would
// truncate the payload and fail the parse.
const MAX_BUFFER = 256 * 1024 * 1024;

// How many jobs to drop per attempt when the response is over budget. Coarse on
// purpose — this is a safety net, not an optimizer.
const TRIM_STEP = 100;

/**
 * Convert a date string to ISO 8601. Callers key "days on market" off this, so a
 * value that cannot be parsed is returned unchanged rather than nulled — a wrong
 * date is visible, a missing one is not.
 *
 * @param {string|number|null} dateStr
 * @returns {string|null}
 */
function convertToISODate(dateStr) {
  if (!dateStr) {return null;}
  try {
    if (!isNaN(dateStr)) {
      const timestamp =
        String(dateStr).length > 10 ? Number(dateStr) : Number(dateStr) * 1000;
      return new Date(timestamp).toISOString();
    }
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {return date.toISOString();}
    logger.warn(`Could not parse date: ${dateStr}`);
    return dateStr;
  } catch (error) {
    logger.warn(`Error converting date: ${dateStr}`, { error: error.message });
    return dateStr;
  }
}

/**
 * Build the argv for jobspy/main.py.
 *
 * Returns a literal argv ARRAY, never a shell string: caller-supplied values
 * (`searchTerm`, `location`, …) stay inert data. Do NOT switch to `exec` or any
 * shell-string form — that was an unauthenticated RCE before it was fixed.
 *
 * @param {object} params - validated search params
 * @param {string} proxy - the server's proxy URL; always present
 * @returns {string[]}
 */
export function buildCommandArgs(params, proxy) {
  const args = [];
  const push = (flag, value) => args.push(flag, String(value));

  if (params.siteNames) {push('--site_name', params.siteNames);}
  if (params.searchTerm) {push('--search_term', params.searchTerm);}
  if (params.location) {push('--location', params.location);}
  if (params.distance) {push('--distance', params.distance);}
  if (params.jobType) {push('--job_type', params.jobType);}
  if (params.googleSearchTerm) {push('--google_search_term', params.googleSearchTerm);}
  if (params.resultsWanted) {push('--results_wanted', params.resultsWanted);}
  if (params.easyApply) {args.push('--easy_apply');}
  if (params.descriptionFormat) {push('--description_format', params.descriptionFormat);}
  if (params.offset) {push('--offset', params.offset);}
  if (params.hoursOld) {push('--hours_old', params.hoursOld);}
  if (params.verbose !== undefined) {push('--verbose', params.verbose);}
  if (params.countryIndeed) {push('--country_indeed', params.countryIndeed);}
  if (params.isRemote) {args.push('--is_remote');}
  if (params.linkedinCompanyIds) {push('--linkedin_company_ids', params.linkedinCompanyIds);}
  if (params.enforceAnnualSalary) {args.push('--enforce_annual_salary');}
  if (params.caCert) {push('--ca_cert', params.caCert);}

  // LinkedIn returns no description during a metadata-only search, so asking for
  // one costs a request per job for text the caller is not being sent.
  if (params.linkedinFetchDescription && !params.metadataOnly) {
    args.push('--linkedin_fetch_description');
  }

  // Unconditional. The proxy is the SERVER's, not the caller's, and no parameter
  // can change, override or omit it.
  push('--proxies', proxy);

  push('--format', params.format || 'json');
  return args;
}

/**
 * Run JobSpy asynchronously. This MUST stay async: `execFileSync` blocks Node's
 * single event loop for the life of the subprocess, so concurrent MCP calls did
 * not run concurrently, they queued. At ~45-85s per LinkedIn search the last
 * call of a 5-wide batch held an open connection for 5-6 minutes; on 2026-08-14
 * one such batch was severed mid-flight and cost a run 14 of its 44 searches.
 * Measured after the fix: 3 concurrent LinkedIn searches in 69s vs 198s serial.
 */
async function runSearchProcess(args, timeout) {
  const { stdout } = await execFileAsync(PYTHON, [SEARCH_SCRIPT, ...args], {
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/**
 * Handler for the search_jobs MCP tool and for the non-MCP `POST /api` shortcut.
 *
 * @param {object} params
 * @param {object} [deps] - seams for testing: the subprocess, stash, log and proxy
 */
export async function searchJobsHandler(params, deps = {}) {
  const {
    runSearch = runSearchProcess,
    cache = descriptionCache,
    orderLog = searchOrderLog,
    proxy = resolveProxy(),
  } = deps;

  // A caller that still sends `proxies` is ignored WITH A WARNING, not rejected:
  // the value is never read either way, and the warning is what makes an
  // un-migrated caller visible. Same pattern as the Gmail watcher's deprecated
  // `?secret=` fallback.
  if (params && params.proxies !== null && params.proxies !== undefined && params.proxies !== '') {
    logger.warn(
      'Ignoring caller-supplied `proxies`: the server owns the proxy. ' +
        'Remove it from the call site.',
    );
  }

  if (!proxy) {
    throw new Error(
      'No usable proxy (SMARTPROXY_URL). Refusing to search the job boards ' +
        'direct — unproxied is a blocked path, not a degraded one.',
    );
  }

  // Strip empties before validation so a caller sending `location: ''` gets the
  // schema default rather than an empty argv value.
  const cleanedParams = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === '' || value === 0) {continue;}
    cleanedParams[key] = value;
  }
  delete cleanedParams.proxies;

  const validated = z.object(searchParams).parse(cleanedParams);
  const args = buildCommandArgs(validated, proxy);

  logger.info('Starting job search', {
    site: validated.siteNames,
    searchTerm: validated.searchTerm,
    location: validated.location,
    resultsWanted: validated.resultsWanted,
    metadataOnly: validated.metadataOnly,
    proxy: maskProxy(proxy),
  });

  const stdout = await runSearch(args, validated.timeout);
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [];

  let jobs = rows.map((row) => {
    const job = changeCase.camelCase(row);
    if (job.datePosted) {job.datePosted = convertToISODate(job.datePosted);}
    return job;
  });

  // Logged BEFORE stashing or trimming, so the recorded positions reflect what
  // the source actually returned.
  orderLog.append({
    site: validated.siteNames,
    searchTerm: validated.searchTerm,
    location: validated.location,
    resultsWanted: validated.resultsWanted,
    jobs,
  });

  if (validated.metadataOnly) {
    // Indeed returns full descriptions inline and free during search; stashing
    // keeps them without shipping a huge payload. LinkedIn returns none here.
    for (const job of jobs) {
      if (job.id && job.description) {cache.put(job.id, job.description);}
      delete job.description;
    }
  }

  const totalFound = jobs.length;
  let omittedForSize = 0;
  const budget = validated.maxResponseChars;
  if (budget > 0) {
    while (jobs.length > 0 && JSON.stringify(jobs).length > budget) {
      const drop = Math.min(TRIM_STEP, jobs.length);
      jobs = jobs.slice(0, jobs.length - drop);
      omittedForSize += drop;
    }
  }

  logger.info(`Found jobs: ${totalFound}`, { returned: jobs.length, omittedForSize });

  const result = { count: totalFound, message: 'Job search completed successfully', jobs };
  if (omittedForSize > 0) {
    // Reported, never silent: a short response and a truncated one are different
    // facts about what a run covered.
    result.totalFound = totalFound;
    result.omittedForSize = omittedForSize;
    result.trimmedToFit = true;
  }
  return result;
}

export const searchJobsTool = (server, sseManager) =>
  server.tool(
    'search_jobs',
    'Search for jobs across various job listing websites',
    searchParams,
    async (params, extra) => {
      let progressInterval;
      try {
        logger.info('Received search_jobs request', { params });

        if (extra?.sessionId && sseManager.hasConnection(extra.sessionId)) {
          let progress = 0;
          progressInterval = setInterval(() => {
            progress = Math.min(progress + 5, 90);
            sseManager.notificationProgress(
              {
                type: 'progress',
                tool: 'search_jobs',
                progress,
                message: `Searching for jobs (${progress}%)...`,
              },
              extra.sessionId,
            );
          }, 2000);
        }

        const result = await searchJobsHandler(params);

        if (progressInterval) {
          clearInterval(progressInterval);
          if (extra?.sessionId && sseManager.hasConnection(extra.sessionId)) {
            sseManager.notificationProgress(
              {
                type: 'progress',
                tool: 'search_jobs',
                progress: 100,
                message: 'Job search completed',
              },
              extra.sessionId,
            );
          }
        }

        return {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (progressInterval) {clearInterval(progressInterval);}
        logger.error('Error in search_jobs handler', { error: error.message });
        return {
          isError: true,
          error: { message: error.message, code: 'INTERNAL_SERVER_ERROR' },
        };
      }
    },
  );
