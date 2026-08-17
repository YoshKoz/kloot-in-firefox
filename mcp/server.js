#!/usr/bin/env node
'use strict';

// MCP server for the kloot-in-firefox extension.
//
// Speaks JSON-RPC 2.0 over stdio, so any MCP client can drive the browser:
// Claude Code, the local-model agent in ../agent, or anything else. It is a
// client of the bridge, sitting in the same seat Claude Code's own browser
// integration would occupy.
//
//   MCP client  --stdio-->  this server  --ws-->  bridge  --ws-->  extension
//
// Hand-rolled rather than built on the MCP SDK: the wire format is a few
// message types and the rest of this repository has one dependency, so adding a
// framework to save fifty lines would be a poor trade.
//
// stdout carries protocol frames only. Diagnostics go to stderr, always — a
// stray console.log here corrupts the stream and the client disconnects.

const readline = require('readline');
const { BridgeClient } = require('./bridge');
const { TOOLS } = require('./tools');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'kloot-in-firefox', version: '1.0.0' };

const bridge = new BridgeClient();
const state = { tabId: null };
const ctx = { bridge, state };

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function log(...args) {
  console.error('[kloot-mcp]', ...args);
}

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const tool = byName.get(params?.name);
  if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);

  try {
    if (!bridge.connected) {
      await bridge.connect();
      await bridge.waitForBrowser();
    }
    if (!bridge.browserReady) {
      // A tool-level error, not a protocol one: the model should see this text
      // and be able to react to it rather than have the call blow up.
      return reply(id, {
        content: [{
          type: 'text',
          text: 'The Firefox extension is not connected to the bridge. Start Firefox with ' +
            'scripts/launch-firefox.sh, install the extension, and make sure bridge/server.js is running.',
        }],
        isError: true,
      });
    }

    const result = await tool.run(ctx, params.arguments ?? {});
    return reply(id, result);
  } catch (err) {
    log(`${params.name} failed: ${err.message}`);
    return reply(id, { content: [{ type: 'text', text: `${params.name} failed: ${err.message}` }], isError: true });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications have no id and take no response.
  if (id === undefined) {
    if (method === 'notifications/initialized') log('client ready');
    return;
  }

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call':
      return handleToolCall(id, params);

    default:
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Calls take seconds (a navigation, a click that triggers one). If stdin closes
// while any are still running, exiting immediately would drop their replies and
// abandon a half-finished browser action, so shutdown waits for them.
const inFlight = new Set();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log('ignoring malformed frame');
    return;
  }
  // Each frame is handled independently; a failure in one must not kill the loop.
  const task = handle(msg)
    .catch((err) => log(`handler error: ${err.message}`))
    .finally(() => inFlight.delete(task));
  inFlight.add(task);
});

async function drainAndExit() {
  if (inFlight.size) {
    log(`draining ${inFlight.size} in-flight call(s)`);
    await Promise.allSettled([...inFlight]);
  }
  bridge.close();
  process.exit(0);
}

rl.on('close', () => {
  drainAndExit();
});

process.on('SIGTERM', () => {
  bridge.close();
  process.exit(0);
});

log(`ready — ${TOOLS.length} tools, bridge at ${bridge.url}`);
