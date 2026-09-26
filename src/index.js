// ABOUTME: Server entry point — picks a transport, refuses to start without a
// ABOUTME: proxy, and serves the MCP tools plus the two non-MCP HTTP shortcuts.
// Copyright (c) 2026 DPSystems, LLC. All rights reserved.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import logger from './logger.js';
import SseManager from './sseManager.js';
import { createApp } from './httpApi.js';
import { resolveProxy, maskProxy } from './proxyCheck.js';
import {
  searchJobsPrompt,
  jobRecommendationsPrompt,
  resumeFeedbackPrompt,
} from './prompts/index.js';
import {
  searchJobsTool,
  fetchDescriptionsTool,
} from './tools/index.js';

const PORT = process.env.JOBSPY_PORT || 9423;
const HOST = process.env.JOBSPY_HOST || '0.0.0.0';
// Coerced with `| 0`, so use 1 / 0 — any non-numeric string evaluates falsy.
const ENABLE_SSE = !!(process.env.ENABLE_SSE | 0);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

const server = new McpServer({
  name: 'JobSpy MCP Server',
  version: '1.0.0',
  description:
    'A Model Context Protocol server that enables searching for jobs across various platforms',
});

const sseManager = new SseManager(server);

searchJobsPrompt(server);
jobRecommendationsPrompt(server);
resumeFeedbackPrompt(server);
searchJobsTool(server, sseManager);
fetchDescriptionsTool(server);

let stdioTransport = null;
let httpServer = null;

async function runServer() {
  logger.info('Starting JobSpy MCP server...');

  // REFUSES TO START without a usable proxy, credential masked. Unproxied is a
  // blocked path, not a degraded one — `browser.py` measured Indeed's Cloudflare
  // admitting this host 0 of 5 times direct — and the worst place to discover a
  // missing proxy is 39 searches into a Friday run.
  let proxy;
  try {
    proxy = resolveProxy();
  } catch (error) {
    logger.error('Refusing to start: SMARTPROXY_URL is unusable', {
      error: error.message,
    });
    process.exit(1);
  }
  if (!proxy) {
    logger.error(
      'Refusing to start: SMARTPROXY_URL is not set. Every job-board request ' +
        'this server makes goes through the proxy, and there is no unproxied path.',
    );
    process.exit(1);
  }
  logger.info(`Proxy configured: ${maskProxy(proxy)}`);

  if (ENABLE_SSE && !AUTH_TOKEN) {
    // On this transport the routes are reachable from the reverse proxy, and
    // `/api` is exactly as powerful as the search tool.
    logger.error('Refusing to start: ENABLE_SSE=1 requires MCP_AUTH_TOKEN.');
    process.exit(1);
  }

  try {
    const connectedTransports = [];

    if (ENABLE_SSE) {
      const app = createApp({
        authToken: AUTH_TOKEN,
        onSse: async (req, res) => {
          const transport = sseManager.createTransport('/messages', res);
          res.on('close', () => {
            sseManager.removeTransport(transport.sessionId);
            logger.info(`Client disconnected: ${transport.sessionId}`);
          });
          await server.connect(transport);
          logger.info(`New SSE client connected: ${transport.sessionId}`);
        },
        onMessages: async (req, res) => {
          const transport = sseManager.getTransport(req);
          if (transport) {
            await transport.handlePostMessage(req, res, req.body);
          } else {
            res.status(400).send('No transport found for sessionId');
          }
        },
      });

      httpServer = app.listen(PORT, HOST, () => {
        logger.info(`HTTP server listening at http://${HOST}:${PORT}`);
      });
      connectedTransports.push('SSE');
      logger.info(`SSE transport at http://${HOST}:${PORT}/sse`);
      logger.info('Shortcuts at POST /api and POST /api/descriptions');
    } else {
      stdioTransport = new StdioServerTransport();
      await server.connect(stdioTransport);
      connectedTransports.push('stdio');
      logger.info('Stdio transport connected');
    }

    if (connectedTransports.length === 0) {
      throw new Error('No transports connected. Check configuration.');
    }
    logger.info(`Transports: ${connectedTransports.join(', ')}`);
  } catch (error) {
    logger.error('Server connection error', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

async function shutdown() {
  logger.info('Shutting down JobSpy MCP server...');
  try {
    await server.disconnect();
    if (httpServer) {
      httpServer.close(() => logger.info('HTTP server closed'));
    }
    logger.info('Server shutdown complete');
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
  } finally {
    setTimeout(() => process.exit(0), 100);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

runServer().catch((error) => {
  logger.error('Unhandled error in server', { error: error.message });
  process.exit(1);
});
