// ABOUTME: The description stash — keeps the full text Indeed returns free
// ABOUTME: during search so a later fetch_descriptions call costs no network.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import logger from './logger.js';

// Indeed returns full descriptions inline during search and LinkedIn returns
// none, so a metadata-only search can keep the Indeed text without shipping a
// huge payload to the caller. The cap is FIFO because a run stashes ~3,000 rows
// and then asks for the survivors it kept — the recent entries are the wanted
// ones.
const DEFAULT_LIMIT = 20000;

/**
 * @param {{limit?: number, dir?: string|null}} [options]
 */
export function createCache({ limit = DEFAULT_LIMIT, dir = null } = {}) {
  /** @type {Map<string, string>} */
  const memory = new Map();
  let diskDir = null;

  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      diskDir = dir;
    } catch (error) {
      // The stash is an optimization, never the source of truth. A search that
      // already cost 45-85s and real proxy traffic must not be lost to a disk
      // problem, so this degrades to memory and says so once.
      logger.warn('Description cache dir unusable; staying in memory', {
        dir,
        error: error.message,
      });
    }
  }

  // Job ids come from the boards, so they are not trusted as filenames — an id
  // shaped like `../../x` would otherwise write outside the cache dir.
  const fileFor = (id) =>
    join(diskDir, `${createHash('sha256').update(id).digest('hex')}.txt`);

  return {
    /**
     * Stash a description. An empty or missing one is NOT stored: "absent" and
     * "has no text" have to stay distinguishable, or a blank description sails
     * into scoring and a posting gets judged on nothing.
     */
    put(id, description) {
      if (!id || typeof description !== 'string' || !description.trim()) {return;}

      // delete-then-set so a re-stash replaces the value without a second entry.
      memory.delete(id);
      memory.set(id, description);
      while (memory.size > limit) {
        memory.delete(memory.keys().next().value);
      }

      if (diskDir) {
        try {
          writeFileSync(fileFor(id), description, 'utf8');
        } catch (error) {
          logger.warn('Could not write a stashed description to disk', {
            error: error.message,
          });
        }
      }
    },

    /**
     * @returns {string|undefined} the description, or undefined on a miss —
     * never an empty string.
     */
    get(id) {
      if (!id) {return undefined;}
      const hit = memory.get(id);
      if (hit) {return hit;}
      if (!diskDir) {return undefined;}
      try {
        // Search and fetch are two separate calls, so a container recreate
        // between them used to turn every Indeed posting into `unavailable`.
        const text = readFileSync(fileFor(id), 'utf8');
        return text.trim() ? text : undefined;
      } catch {
        return undefined;
      }
    },

    has(id) {
      return this.get(id) !== undefined;
    },

    size() {
      return memory.size;
    },
  };
}

// The process-wide stash the search and fetch handlers share. Both must be the
// same Node process for a memory hit; the cache dir is what makes a hit survive
// a restart.
export const descriptionCache = createCache({
  limit: Number(process.env.DESCRIPTION_CACHE_LIMIT) || DEFAULT_LIMIT,
  dir: process.env.DESCRIPTION_CACHE_DIR || null,
});
