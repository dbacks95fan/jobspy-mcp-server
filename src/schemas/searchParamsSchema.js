import { z } from 'zod';

export const searchParams = {
  siteNames: z
    .union([
      z
        .string()
        .describe(
          'Comma-separated list of job sites to search. Options: indeed,linkedin,zip_recruiter,glassdoor,google,bayt,naukri'
        ),
      z
        .array(z.string())
        .describe(
          'Array of job sites to search. Options: indeed,linkedin,zip_recruiter,glassdoor,google,bayt,naukri'
        ),
    ])
    .transform((val) => {
      // If it's already a string, return it as is
      if (typeof val === 'string') {
        return val;
      }
      // If it's an array, join it with commas
      if (Array.isArray(val)) {
        return val.join(',');
      }
      return val;
    })
    .refine(
      (val) => {
        const sites = val.split(',').map((site) => site.trim());
        const validSites = [
          'indeed',
          'linkedin',
          'zip_recruiter',
          'glassdoor',
          'google',
          'bayt',
          'naukri',
        ];
        return sites.every((site) => validSites.includes(site));
      },
      {
        message:
          'Invalid site names. Allowed values: indeed, linkedin, zip_recruiter, glassdoor, google, bayt, naukri',
      }
    )
    .default('indeed'),
  searchTerm: z
    .string()
    .describe('Search term for jobs')
    .default('software engineer'),
  location: z.string().describe('Location for job search').default('remote'),
  distance: z.number().int().describe('Distance in miles').default(50),
  jobType: z
    .enum(['fulltime', 'parttime', 'internship', 'contract'])
    .nullable()
    .describe('Type of job')
    .default(null),
  googleSearchTerm: z
    .string()
    .nullable()
    .describe('Google specific search term')
    .default(null),
  resultsWanted: z
    .number()
    .int()
    .describe('Number of results wanted')
    .transform((val) => (val === 0 ? 20 : val))
    .default(20),
  easyApply: z
    .boolean()
    .describe('Filter for jobs that are hosted on the job board site')
    .default(false),
  descriptionFormat: z
    .enum(['markdown', 'html'])
    .describe('Format type of the job descriptions')
    .default('markdown'),
  offset: z
    .number()
    .int()
    .describe('Starts the search from an offset')
    .default(0),
  hoursOld: z
    .number()
    .int()
    .describe('How many hours old the jobs can be')
    .transform((val) => (val === 0 ? 72 : val))
    .default(72),
  verbose: z
    .number()
    .int()
    .min(0)
    .max(2)
    .describe(
      'Controls verbosity (0=errors only, 1=errors+warnings, 2=all logs)'
    )
    .default(2),
  countryIndeed: z
    .string()
    .describe('Country for Indeed search')
    .default('USA'),
  isRemote: z
    .any()
    .describe(
      'Whether to search for remote jobs only. Accepts any truthy value.'
    )
    .transform((val) => {
      // Convert any truthy value to boolean
      if (typeof val === 'string') {
        // For strings, check for common "true" values
        return ['true', 'yes', '1', 'on', 'y'].includes(val.toLowerCase());
      }
      // For other types, use Boolean conversion
      return Boolean(val);
    })
    .default(false),
  linkedinFetchDescription: z
    .any()
    .describe(
      'Whether to fetch LinkedIn job descriptions (slower). Accepts any truthy value.'
    )
    .transform((val) => {
      // Convert any truthy value to boolean
      if (typeof val === 'string') {
        // For strings, check for common "true" values
        return ['true', 'yes', '1', 'on', 'y'].includes(val.toLowerCase());
      }
      // For other types, use Boolean conversion
      return Boolean(val);
    })
    .default(true),
  linkedinCompanyIds: z
    .union([
      z.string().describe('Comma-separated list of LinkedIn company IDs'),
      z.array(z.number()).describe('Array of LinkedIn company IDs'),
    ])
    .nullable()
    .transform((val) => {
      if (typeof val === 'string') {
        return val;
      }
      if (Array.isArray(val)) {
        return val.join(',');
      }
      return val;
    })
    .default(null),
  enforceAnnualSalary: z
    .boolean()
    .describe('Converts wages to annual salary')
    .default(false),
  // `proxies` is deliberately NOT a parameter. The server reads SMARTPROXY_URL
  // from its own environment and injects it unconditionally, so there is no way
  // for a caller to express an unproxied job-board request. Re-adding it here
  // restores the 2026-09-13 bug; tests/proxyInvariant.test.mjs pins its absence.
  metadataOnly: z
    .boolean()
    .describe(
      'Strip each description from the response and stash it server-side for ' +
        'fetch_descriptions. Keeps a high-volume search from overflowing the ' +
        "caller's context."
    )
    .default(false),
  maxResponseChars: z
    .number()
    .int()
    .min(0)
    .describe(
      'Context-overflow safety net: if the serialized job array would exceed ' +
        'this, drop jobs until it fits and report the shortfall. 0 disables it.'
    )
    .default(0),
  caCert: z
    .string()
    .nullable()
    .describe('Path to CA Certificate file for proxies')
    .default(null),
  format: z.enum(['json', 'csv']).describe('Output format').default('json'),
  timeout: z
    .number()
    .int()
    .describe('Timeout in milliseconds for the job search process')
    .default(120000),
};
