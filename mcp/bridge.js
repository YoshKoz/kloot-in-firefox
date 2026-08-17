'use strict';

// Controller-side client for the kloot bridge.
//
// This is the seat Claude Code occupies when it runs with LOCAL_BRIDGE=1: it
// connects as the controller, the extension connects as the browser, and the
// bridge relays tool_call / tool_result between them. Anything that speaks this
// protocol can drive the browser — which is the whole point of putting an MCP
// server and a local model on this end instead.

const WebSocket = require('ws');

const DEFAULT_PORT = Number(process.env.KLOOT_PORT || 8765);
const DEFAULT_HOST = process.env.KLOOT_HOST || '127.0.0.1';
const CALL_TIMEOUT_MS = Number(process.env.KLOOT_CALL_TIMEOUT || 60000);

class BridgeClient {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
    this.url = `ws://${host}:${port}/claude-code/dev_user_local`;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    // The extension announces itself through the bridge, so we can tell the
    // difference between "no bridge" and "bridge up, browser missing".
    this.browserReady = false;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect() {
    if (this.connected) return;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`bridge did not accept a connection on ${this.url} — is server.js running?`));
      }, 5000);

      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`cannot reach the kloot bridge at ${this.url}: ${err.message}`));
      });
    });

    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('close', () => {
      this.browserReady = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('bridge connection closed'));
      }
      this.pending.clear();
    });

    this.ws.send(JSON.stringify({
      type: 'connect',
      client_type: 'claude-code',
      dev_user_id: 'dev_user_local',
    }));

    // 'paired' means the extension was already there; 'waiting' means it is not.
    const hello = await this._nextOf(['paired', 'waiting'], 5000).catch(() => null);
    this.browserReady = hello?.type === 'paired';
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'peer_connected') this.browserReady = true;
    if (msg.type === 'peer_disconnected') this.browserReady = false;
    if (msg.type === 'ping') this.ws.send(JSON.stringify({ type: 'pong' }));

    this._notify(msg);

    if (msg.type !== 'tool_result') return;
    const entry = this.pending.get(msg.tool_use_id);
    if (!entry) return;
    this.pending.delete(msg.tool_use_id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  // Minimal one-shot listener support, used only during the handshake.
  _notify(msg) {
    const waiters = this._waiters ?? [];
    this._waiters = waiters.filter((w) => !w.match(msg));
    for (const w of waiters) if (w.match(msg)) w.resolve(msg);
  }

  _nextOf(types, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      this._waiters = this._waiters ?? [];
      this._waiters.push({
        match: (m) => types.includes(m.type),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  // Waits for the extension to show up, so a freshly started agent does not fail
  // its first call just because Firefox is still booting.
  async waitForBrowser(timeoutMs = 20000) {
    if (this.browserReady) return true;
    await this._nextOf(['peer_connected', 'paired'], timeoutMs).catch(() => null);
    return this.browserReady;
  }

  async call(tool, args = {}) {
    if (!this.connected) await this.connect();

    const toolUseId = `mcp-${++this.seq}`;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseId);
        reject(new Error(`${tool} did not return within ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(toolUseId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'tool_call', tool_use_id: toolUseId, tool, args }));
    });

    return result;
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

// Tool results arrive as content blocks; most callers just want the text.
function textOf(result) {
  return result?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';
}

function imageOf(result) {
  return result?.content?.find((c) => c.type === 'image') ?? null;
}

// Several tools answer with JSON in a text block.
function jsonOf(result) {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { BridgeClient, textOf, imageOf, jsonOf };
