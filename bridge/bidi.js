'use strict';

// Minimal WebDriver BiDi client.
//
// This is the replacement for Chrome's chrome.debugger / CDP. Firefox exposes a
// BiDi endpoint when started with --remote-debugging-port, which gives us the
// two things a WebExtension cannot do: trusted input events and reliable
// screenshots of a specific browsing context.
//
// Everything here degrades gracefully: if Firefox was not started with remote
// debugging, connect() fails and the caller falls back to DOM-level tools.

const WebSocket = require('ws');
const { EventEmitter } = require('events');

const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 30000;

class BidiClient extends EventEmitter {
  constructor({ host, port }) {
    super();
    this.url = `ws://${host}:${port}/session`;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.subscriptions = new Set();
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
        reject(new Error(`BiDi connect timed out after ${CONNECT_TIMEOUT_MS}ms (${this.url})`));
      }, CONNECT_TIMEOUT_MS);

      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('close', () => {
      this.sessionId = null;
      this.subscriptions.clear();
      for (const { reject } of this.pending.values()) {
        reject(new Error('BiDi socket closed'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });

    // Firefox permits exactly one BiDi session at a time. If another client
    // holds it — or a previous one exited without calling session.end — there is
    // no way to attach, so fail with an instruction rather than continuing and
    // hitting "invalid session id" on the first real command.
    const result = await this.command('session.new', { capabilities: {} }).catch((err) => {
      if (/maximum number of active sessions|already/i.test(err.message)) {
        throw new Error(
          'Firefox already has an active WebDriver BiDi session (only one is allowed). ' +
            'Close the other client or restart Firefox.',
        );
      }
      throw err;
    });
    this.sessionId = result?.sessionId ?? null;
    this.emit('connected');
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'event') {
      this.emit('event', msg);
      this.emit(msg.method, msg.params);
      return;
    }

    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.type === 'error') {
      entry.reject(new Error(`${msg.error}: ${msg.message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  command(method, params = {}) {
    if (!this.connected) return Promise.reject(new Error('BiDi not connected'));
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BiDi command ${method} timed out`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Ends the BiDi session and closes the socket. Skipping this leaves the
  // session registered and Firefox will refuse to create the next one.
  async close() {
    if (this.connected) {
      await this.command('session.end', {}).catch(() => {});
      this.ws.close();
    }
    this.ws = null;
    this.sessionId = null;
  }

  async subscribe(events) {
    const fresh = events.filter((e) => !this.subscriptions.has(e));
    if (!fresh.length) return;
    await this.command('session.subscribe', { events: fresh });
    fresh.forEach((e) => this.subscriptions.add(e));
  }

  // --- context helpers -----------------------------------------------------

  async contexts() {
    const { contexts } = await this.command('browsingContext.getTree', {});
    return contexts ?? [];
  }

  // Extension tab ids and BiDi context ids are different namespaces, so the URL
  // is the only stable join key we have between the two views of a tab.
  async contextForUrl(url) {
    if (!url) return null;
    const contexts = await this.contexts();
    const exact = contexts.find((c) => c.url === url);
    if (exact) return exact.context;
    // Fall back to ignoring the fragment/trailing slash differences.
    const norm = (u) => String(u).replace(/#.*$/, '').replace(/\/$/, '');
    const loose = contexts.find((c) => norm(c.url) === norm(url));
    return loose?.context ?? null;
  }

  async activeContext() {
    const contexts = await this.contexts();
    return contexts[0]?.context ?? null;
  }

  async screenshot(context) {
    const { data } = await this.command('browsingContext.captureScreenshot', { context });
    return data; // base64 PNG
  }

  async navigate(context, url) {
    return this.command('browsingContext.navigate', { context, url, wait: 'complete' });
  }

  async evaluate(context, expression, awaitPromise = true) {
    return this.command('script.evaluate', {
      expression,
      target: { context },
      awaitPromise,
      resultOwnership: 'none',
    });
  }

  // --- trusted input -------------------------------------------------------
  //
  // input.performActions produces real, untrusted-flag-free events, which is the
  // whole reason for running Firefox with remote debugging.

  async click(context, x, y, button = 0) {
    return this.command('input.performActions', {
      context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button },
            { type: 'pause', duration: 30 },
            { type: 'pointerUp', button },
          ],
        },
      ],
    });
  }

  async doubleClick(context, x, y) {
    return this.command('input.performActions', {
      context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
            { type: 'pause', duration: 40 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
  }

  async moveMouse(context, x, y) {
    return this.command('input.performActions', {
      context,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }],
        },
      ],
    });
  }

  async typeText(context, text) {
    const chars = Array.from(String(text));
    return this.command('input.performActions', {
      context,
      actions: [
        {
          type: 'key',
          id: 'keyboard',
          actions: chars.flatMap((ch) => [
            { type: 'keyDown', value: ch },
            { type: 'keyUp', value: ch },
          ]),
        },
      ],
    });
  }

  // Accepts either a single key name ("Enter") or a chord ("Control+a").
  async pressKey(context, key) {
    const parts = String(key).split('+');
    const main = parts.pop();
    const mods = parts.map((m) => KEY_MAP[m.toLowerCase()] ?? m);
    const value = KEY_MAP[main.toLowerCase()] ?? main;

    return this.command('input.performActions', {
      context,
      actions: [
        {
          type: 'key',
          id: 'keyboard',
          actions: [
            ...mods.map((m) => ({ type: 'keyDown', value: m })),
            { type: 'keyDown', value },
            { type: 'keyUp', value },
            ...mods.reverse().map((m) => ({ type: 'keyUp', value: m })),
          ],
        },
      ],
    });
  }

  async scroll(context, x, y, deltaX, deltaY) {
    return this.command('input.performActions', {
      context,
      actions: [
        {
          type: 'wheel',
          id: 'wheel',
          actions: [
            {
              type: 'scroll',
              x: Math.round(x),
              y: Math.round(y),
              deltaX: Math.round(deltaX),
              deltaY: Math.round(deltaY),
            },
          ],
        },
      ],
    });
  }
}

// WebDriver uses Unicode private-use codepoints for non-printable keys.
const KEY_MAP = {
  control: '\uE009',
  ctrl: '\uE009',
  alt: '\uE00A',
  shift: '\uE008',
  meta: '\uE03D',
  super: '\uE03D',
  cmd: '\uE03D',
  enter: '\uE007',
  return: '\uE007',
  tab: '\uE004',
  escape: '\uE00C',
  esc: '\uE00C',
  backspace: '\uE003',
  delete: '\uE017',
  home: '\uE011',
  end: '\uE010',
  pageup: '\uE00E',
  pagedown: '\uE00F',
  arrowup: '\uE013',
  up: '\uE013',
  arrowdown: '\uE015',
  down: '\uE015',
  arrowleft: '\uE012',
  left: '\uE012',
  arrowright: '\uE014',
  right: '\uE014',
  space: ' ',
};

module.exports = { BidiClient };
