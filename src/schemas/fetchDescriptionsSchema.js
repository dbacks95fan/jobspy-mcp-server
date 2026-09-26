// ABOUTME: Parameter schema for fetch_descriptions — the deferred half of a
// ABOUTME: metadata-first search, taking the postings the caller chose to keep.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { z } from 'zod';

export const fetchDescriptionsParams = {
  jobs: z
    .array(
      z.object({
        id: z.string().describe('The job id as returned by search_jobs'),
        url: z.string().describe('The posting URL'),
      }),
    )
    .min(1)
    .describe('The postings to retrieve descriptions for'),
  descriptionFormat: z
    .enum(['markdown', 'html'])
    .describe('Format type of the job descriptions')
    .default('markdown'),
  includeMetadata: z
    .boolean()
    .describe(
      'Also return title/company. BYPASSES the stash (which holds descriptions ' +
        'only, so a hit would return both fields null) and costs LinkedIn one ' +
        'extra request per job — leave false when the caller already knows them.',
    )
    .default(false),
  timeout: z
    .number()
    .int()
    .describe('Timeout in milliseconds for the fetch subprocess')
    .default(180000),
  // No `proxies`, deliberately — the server owns it. See proxyCheck.js and
  // tests/proxyInvariant.test.mjs.
};
