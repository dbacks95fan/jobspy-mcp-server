// ABOUTME: Appends one JSON line per search recording the ORDER a board returned
// ABOUTME: its job ids in — the ground truth for tuning search depth.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import logger from './logger.js';

// Ids only, so the file stays small (~90KB/run) and carries nothing sensitive.
// Two analyses read it, both costing zero agent tokens: finalist POSITION vs
// `resultsWanted`, and cross-search overlap. Position is only meaningful because
// JobSpy sends LinkedIn no `sortBy`, so results arrive in relevance order — if
// that ever changes to date ordering, every position-based conclusion is void.
//
// It exists because the agent cannot be trusted to compute this in-context: on
// 2026-08-14 it reported "no tool-level errors" for a run with five `is_error`
// results, and filed one search's retries under a search that never ran.

/**
 * @param {{dir: string}} options - the cache root; rows land in `<dir>/search-order`.
 */
export function createSearchOrderLog({ dir }) {
  const logDir = join(dir, 'search-order');
  let ready = false;

  const ensureDir = () => {
    if (ready) {return true;}
    try {
      mkdirSync(logDir, { recursive: true });
      ready = true;
    } catch (error) {
      logger.warn('Search-order log dir unusable', { logDir, error: error.message });
    }
    return ready;
  };

  return {
    /**
     * Called from the search handler BEFORE stashing or size-trimming, so the
     * recorded positions reflect what the source actually returned rather than
     * what survived the response budget.
     *
     * Never throws: the search has already been paid for by the time this runs.
     */
    append({ site, searchTerm, location, resultsWanted, jobs }) {
      try {
        if (!ensureDir()) {return;}
        const rows = Array.isArray(jobs) ? jobs : [];
        const ts = new Date().toISOString();
        const row = {
          ts,
          site: site ?? null,
          searchTerm: searchTerm ?? null,
          location: location ?? null,
          resultsWanted: resultsWanted ?? null,
          count: rows.length,
          // Ids only. Never the description, the salary or the company.
          ids: rows
            .map((job) => job?.id)
            .filter((id) => id !== null && id !== undefined),
        };
        const file = join(logDir, `search-order-${ts.slice(0, 10)}.jsonl`);
        appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      } catch (error) {
        logger.warn('Could not append to the search-order log', { error: error.message });
      }
    },
  };
}

export const searchOrderLog = createSearchOrderLog({
  dir: process.env.DESCRIPTION_CACHE_DIR
    ? join(process.env.DESCRIPTION_CACHE_DIR, '..')
    : '/app/cache',
});
