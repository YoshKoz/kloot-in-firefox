'use strict';

// kloot-in-firefox bridge.
//
// Two peers connect to this relay:
//   * the controller (Claude Code, started with LOCAL_BRIDGE=1)
//   * the browser    (the kloot-in-firefox extension)
//
// The relay pairs them and forwards tool_call / tool_result between the two.
// Tools that a WebExtension cannot implement (trusted input, per-context
// screenshots, console and network capture) are intercepted here and served
// over WebDriver BiDi instead.

const { WebSocketServer } = require('ws');
const config = require('./config');
const { BidiClient } = require('./bidi');
const { handleBidiTool, BIDI_TOOLS, resolveBrowserQuery } = require('./tools-bidi');

const SECRET_KEYS = new Set(['oauth_token', 'token', 'access_token', 'refresh_token']);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEYS.has(k.toLowerCase()) ? '<redacted>' : redact(v),
      ]),
    );
  }
  return value;
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function debug(...args) {
  if (config.verbose) log(...args);
}

// --- peer registry ---------------------------------------------------------

/** @type {{controller: any, browser: any}} */
const peers = { controller: null, browser: null };

function otherRole(role) {
  return role === 'controller' ? 'browser' : 'controller';
}

function send(ws, msg) {
  if (ws?.readyState !== ws?.OPEN && ws?.readyState !== 1) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function notifyPeer(role, type) {
  const peer = peers[otherRole(role)];
  if (peer) send(peer, { type });
}

// The extension announces itself with a browser-ish client_type; anything else
// (claude-code, desktop, cli) is treated as the controlling side.
const BROWSER_CLIENT_TYPES = new Set(['firefox-extension', 'chrome-extension', 'browser']);

function roleForConnect(msg, url) {
  if (msg.client_type && BROWSER_CLIENT_TYPES.has(msg.client_type)) return 'browser';
  if (/^\/(chrome|firefox|browser)\//.test(url || '')) return 'browser';
  return 'controller';
}

// --- BiDi ------------------------------------------------------------------

const bidi = new BidiClient({ host: config.bidiHost, port: config.bidiPort });
let bidiReady = false;

async function ensureBidi() {
  if (!config.bidiEnabled) return false;
  if (bidiReady && bidi.connected) return true;
  try {
    await bidi.connect();
    bidiReady = true;
    log(`BiDi connected on ${config.bidiHost}:${config.bidiPort} — trusted input available`);
    return true;
  } catch (err) {
    bidiReady = false;
    debug(`BiDi unavailable: ${err.message}`);
    return false;
  }
}

bidi.on('disconnected', () => {
  bidiReady = false;
  log('BiDi disconnected — falling back to DOM-level tools');
});

// --- tool routing ----------------------------------------------------------

function toolResult(toolUseId, payload) {
  return { type: 'tool_result', tool_use_id: toolUseId, ...payload };
}

function errorResult(toolUseId, message, errorCode) {
  return toolResult(toolUseId, {
    content: [{ type: 'text', text: String(message) }],
    is_error: true,
    ...(errorCode && { error_code: errorCode }),
  });
}

async function routeToolCall(msg) {
  const toolUseId = msg.tool_use_id;
  const tool = msg.tool;

  if (!toolUseId || !tool) return; // malformed; the real extension drops these silently

  // Tools that need real input events or protocol-level capture go to BiDi,
  // but only if Firefox was actually started with remote debugging.
  if (BIDI_TOOLS.has(tool)) {
    const available = await ensureBidi();
    if (available) {
      try {
        const result = await handleBidiTool({ bidi, tool, args: msg.args || {}, browser: peers.browser });
        return send(peers.controller, toolResult(toolUseId, result));
      } catch (err) {
        log(`BiDi tool ${tool} failed: ${err.message}`);
        // Fall through to the extension, which may have a DOM-level fallback.
      }
    }
  }

  if (!peers.browser) {
    return send(
      peers.controller,
      errorResult(
        toolUseId,
        'Firefox extension is not connected. Load the kloot-in-firefox extension and make sure the bridge is running.',
        'browser_disconnected',
      ),
    );
  }

  send(peers.browser, msg);
}

// --- server ----------------------------------------------------------------

const wss = new WebSocketServer({ port: config.port, host: config.host });

wss.on('listening', () => {
  log(`kloot bridge listening on ws://${config.host}:${config.port}`);
  ensureBidi();
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(
      `Port ${config.port} is already in use. Claude Code only talks to 8765, so free that port ` +
        `(or set KLOOT_PORT for a standalone test).`,
    );
    process.exit(1);
  }
  throw err;
});

wss.on('connection', (ws, req) => {
  let role = null;

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // --- handshake ---
    if (msg.type === 'connect') {
      role = roleForConnect(msg, req.url);

      if (peers[role]) {
        debug(`replacing existing ${role} connection`);
        peers[role].close(4000, 'replaced');
      }
      peers[role] = ws;
      log(`${role} connected (client_type=${msg.client_type ?? 'unknown'}, url=${req.url})`);
      debug('connect frame:', JSON.stringify(redact(msg)));

      const paired = Boolean(peers[otherRole(role)]);
      send(ws, { type: paired ? 'paired' : 'waiting' });
      if (paired) {
        send(peers[otherRole(role)], { type: 'peer_connected' });
        send(ws, { type: 'peer_connected' });
      }
      return;
    }

    if (msg.type === 'ping') return void send(ws, { type: 'pong' });
    if (msg.type === 'pong') return;

    if (!role) {
      debug('message before connect, ignoring:', msg.type);
      return;
    }

    // Answers to our own metadata lookups terminate here rather than being
    // relayed on to Claude Code.
    if (msg.type === 'bridge_query_result' && resolveBrowserQuery(msg)) return;

    // --- routing ---
    if (msg.type === 'tool_call' && role === 'controller') {
      debug(`tool_call ${msg.tool} (${msg.tool_use_id})`);
      return void routeToolCall(msg);
    }

    // Everything else is relayed verbatim to the other side.
    const peer = peers[otherRole(role)];
    if (peer) {
      send(peer, msg);
    } else {
      debug(`dropping ${msg.type} from ${role}: no peer`);
    }
  });

  ws.on('close', (code, reason) => {
    if (!role || peers[role] !== ws) return;
    peers[role] = null;
    log(`${role} disconnected (code=${code}${reason?.length ? ` reason=${reason}` : ''})`);
    notifyPeer(role, 'peer_disconnected');
  });

  ws.on('error', (err) => log(`socket error (${role ?? 'unknown'}): ${err.message}`));
});

// Firefox keeps a BiDi session registered until someone calls session.end, and
// it allows exactly one at a time. Exiting without releasing it means the next
// bridge (or install-extension run) cannot attach until Firefox is restarted, so
// shutdown has to go through bidi.close().
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${signal})`);

  const forced = setTimeout(() => process.exit(1), 5000);
  forced.unref();

  await bidi.close().catch((err) => log(`BiDi close failed: ${err.message}`));
  wss.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
