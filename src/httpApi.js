// ABOUTME: The Express surface — the bearer gate, /health, and the two non-MCP
// ABOUTME: shortcuts the runner and the tailor agent call with no model in the loop.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';

import logger from './logger.js';
import { searchJobsHandler } from './tools/search-jobs.js';
import { fetchDescriptionsHandler } from './tools/fetch-descriptions.js';

// A search can return several MB of JSON; a description batch of 25 rather more.
const BODY_LIMIT = '64mb';

/**
 * Constant-time token comparison, so a wrong token cannot be narrowed down by
 * timing the response.
 */
function tokenMatches(expected, given) {
  if (!expected || !given) {return false;}
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) {return false;}
  return timingSafeEqual(a, b);
}

/**
 * @param {object} options
 * @param {string} options.authToken - MCP_AUTH_TOKEN; absent means refuse all
 * @param {Function} [options.searchJobs] - seam for testing
 * @param {Function} [options.fetchDescriptions] - seam for testing
 * @param {Function} [options.onSse] - GET /sse handler, when a transport exists
 * @param {Function} [options.onMessages] - POST /messages handler
 */
export function createApp({
  authToken,
  searchJobs = searchJobsHandler,
  fetchDescriptions = fetchDescriptionsHandler,
  onSse = null,
  onMessages = null,
} = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

  // Unauthenticated ON PURPOSE, and the only such route: a deploy check has no
  // token, and this returns nothing a caller could not learn by connecting.
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  // Everything below this line is as powerful as the MCP tools themselves —
  // `/api` reaches the search handler with no MCP framing — and this container is
  // reachable from the internet through the reverse proxy. An ABSENT token
  // therefore refuses every call rather than opening the door.
  const requireAuth = (req, res, next) => {
    const header = req.get('authorization') || '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!tokenMatches(authToken, given)) {
      if (!authToken) {
        logger.error('MCP_AUTH_TOKEN is not set; refusing every authenticated call');
      }
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  const run = (label, handler) => async (req, res) => {
    try {
      res.json(await handler(req.body));
    } catch (error) {
      // Answered, never left hanging: a wedged request is the silent shape that
      // produces a run which is neither finished nor failed.
      logger.error(`Error in ${label}`, { error: error.message });
      res.status(500).json({ error: error.message });
    }
  };

  app.post('/api', requireAuth, run('POST /api', (body) => searchJobs(body)));
  app.post(
    '/api/descriptions',
    requireAuth,
    run('POST /api/descriptions', (body) => fetchDescriptions(body)),
  );

  if (onSse) {app.get('/sse', requireAuth, onSse);}
  if (onMessages) {app.post('/messages', requireAuth, onMessages);}

  return app;
}
