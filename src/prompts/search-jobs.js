import { z } from 'zod';


/**
 * Complete search jobs prompt definition for MCP server
 */
/**
 * Complete search jobs prompt definition for MCP server
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server - The MCP server instance
 * @returns {Object} The configured prompt
 */
export const searchJobsPrompt = server => server.prompt(
  'search_jobs',
  'Extract job search parameters from a natural language query',
  // A raw shape, NOT z.object(...): the MCP SDK builds the object itself and
  // hands a wrapped schema to its shape walker, which reads `null` off it and
  // crashes the server at registration — before any transport is connected.
  {
    query: z.string().describe('Job search query'),
  },
  (inputs) => {
    return {
      messages: [
        {
          role: 'system',
          content: `
You are a helpful assistant who helps users search for jobs by understanding their job search requirements.
Based on the user query, extract the search parameters needed to find relevant jobs.
`,
        },
        {
          role: 'user',
          content: `
Extract search parameters from the following job search query: "${inputs.query}"

Provide the following information:
1. Job title or keywords
2. Location (if specified, otherwise assume "Remote")
3. Any specific companies mentioned
4. Job type preferences (full-time, part-time, contract, etc.)
5. Experience level requirements (entry, mid, senior)
        `,
        },
      ],
    };
  },
);
