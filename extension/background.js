'use strict';

// Background page: owns the bridge socket and implements the DOM-level tools.
//
// Tools needing trusted input or protocol-level capture never reach here — the
// bridge serves those over WebDriver BiDi.

// Claude Code only ever dials 8765, so that is the default. It is overridable
// from storage (browser.storage.local.set({bridgeUrl})) for testing alongside
// another service that already owns the port.
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8765/firefox/dev_user_local';
let bridgeUrl = DEFAULT_BRIDGE_URL;

const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 90000;
const MAX_BACKOFF_MS = 300000;

let socket = null;
let pingTimer = null;
let attempt = 0;
let lastPong = 0;

// Tabs this bridge opened, so tabs_*_mcp tools stay scoped to our own work and
// never touch the tabs a person is using. Firefox's tabGroups API is too new to
// depend on, so the group is tracked here instead.
const mcpTabs = new Set();

function log(...args) {
  console.log('[kloot]', ...args);
}

function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// --- connection ------------------------------------------------------------

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  log('connecting to', bridgeUrl);
  const ws = new WebSocket(bridgeUrl);
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    attempt = 0;
    lastPong = Date.now();
    send({
      type: 'connect',
      client_type: 'firefox-extension',
      device_id: 'kloot-local',
      os_platform: navigator.platform || 'Linux',
      extension_version: browser.runtime.getManifest().version,
      dev_user_id: 'dev_user_local',
    });
    startPing();
  };

  ws.onmessage = async (event) => {
    if (socket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    await handleMessage(msg);
  };

  ws.onclose = (event) => {
    if (socket !== ws) return;
    stopPing();
    socket = null;
    scheduleReconnect(event.code);
  };

  ws.onerror = () => {
    // onclose always follows, so reconnection is handled there.
  };
}

function scheduleReconnect(code) {
  attempt += 1;
  const base = Math.min(2000 * Math.pow(1.5, attempt - 1), MAX_BACKOFF_MS);
  const delay = base * (0.8 + 0.4 * Math.random());
  log(`disconnected (code=${code}); retrying in ${Math.round(delay)}ms`);
  setTimeout(connect, delay);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (lastPong && Date.now() - lastPong > PONG_TIMEOUT_MS) {
      log('pong timeout; reconnecting');
      socket.close(4001, 'pong-timeout');
      return;
    }
    send({ type: 'ping' });
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

// --- message handling ------------------------------------------------------

async function handleMessage(msg) {
  switch (msg.type) {
    case 'paired':
    case 'waiting':
      log(`bridge ${msg.type}`);
      return;
    case 'ping':
      return send({ type: 'pong' });
    case 'pong':
      lastPong = Date.now();
      return;
    case 'peer_connected':
      log('Claude Code connected');
      return;
    case 'peer_disconnected':
      log('Claude Code disconnected');
      return;
    case 'bridge_query':
      return handleBridgeQuery(msg);
    case 'tool_call':
      return handleToolCall(msg);
    default:
      return;
  }
}

async function handleBridgeQuery(msg) {
  let result = null;
  try {
    if (msg.method === 'get_tab_url') {
      const tab = await browser.tabs.get(msg.params.tabId);
      result = tab.url;
    }
  } catch {
    result = null;
  }
  send({ type: 'bridge_query_result', id: msg.id, result });
}

async function handleToolCall(msg) {
  const { tool_use_id: toolUseId, tool, args = {} } = msg;
  if (!toolUseId || !tool) return;

  try {
    const handler = TOOLS[tool];
    if (!handler) {
      return send(errorResult(toolUseId, `Tool "${tool}" is not implemented by kloot-in-firefox.`, 'tool_not_found'));
    }
    const result = await handler(args);
    send({ type: 'tool_result', tool_use_id: toolUseId, ...result });
  } catch (err) {
    send(errorResult(toolUseId, err?.message ?? String(err), 'tool_execution_exception'));
  }
}

function errorResult(toolUseId, text, code) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text }],
    is_error: true,
    ...(code && { error_code: code }),
  };
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 1));
}

// --- tab helpers -----------------------------------------------------------

async function resolveTab(args) {
  if (typeof args.tabId === 'number') {
    return browser.tabs.get(args.tabId); // throws if the tab is gone
  }
  // Prefer a tab this bridge owns over whatever the user happens to be viewing.
  for (const id of mcpTabs) {
    try {
      return await browser.tabs.get(id);
    } catch {
      mcpTabs.delete(id);
    }
  }
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error('no open tab available');
  return active;
}

function describeTab(tab) {
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    status: tab.status,
    windowId: tab.windowId,
    audible: tab.audible ?? false,
    owned: mcpTabs.has(tab.id),
  };
}

// Waits for a tab to finish loading so a navigate is not reported as done while
// the page is still blank.
//
// A freshly created tab reports status "complete" for its initial about:blank
// before the requested URL starts loading, so waiting on status alone returns
// the wrong page. When a real destination was requested we also require the tab
// to have left about:blank.
function waitForLoad(tabId, { expectNavigation = false, timeoutMs = 30000 } = {}) {
  const isReady = (tab) =>
    tab.status === 'complete' && (!expectNavigation || (tab.url && tab.url !== 'about:blank'));

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, _changeInfo, tab) => {
      if (id === tabId && isReady(tab)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs
      .get(tabId)
      .then((tab) => {
        if (isReady(tab)) finish();
      })
      .catch(finish);
  });
}

// Waits for the *next* top-frame load in a tab.
//
// waitForLoad cannot be used when re-pointing a tab that is already loaded: the
// old document still reports status "complete", so it returns before the new
// page has even started. The listener has to be armed before tabs.update is
// called, otherwise the load can complete in the gap.
function waitForTopFrameLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.webNavigation.onCompleted.removeListener(onCompleted);
      clearTimeout(timer);
      resolve();
    };
    const onCompleted = (details) => {
      if (details.tabId === tabId && details.frameId === 0) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    browser.webNavigation.onCompleted.addListener(onCompleted);
  });
}

async function runInTab(tab, func, arg) {
  const [result] = await browser.tabs.executeScript(tab.id, {
    code: `(${func})(${JSON.stringify(arg ?? null)})`,
  });
  return result;
}

// --- visual overlay --------------------------------------------------------
//
// The renderer in overlay.js is shared with the bridge, which evaluates the same
// file over BiDi. Both halves find each other through the DOM (a shared shadow
// host) rather than through `window`, so the extension's isolated world and the
// page's main world drive one overlay instead of two.
//
// Re-injecting before every call is deliberate: the script is idempotent, so a
// re-send is either a no-op or the repair that reinstalls the overlay after the
// document was replaced. Pointer position is not remembered here — the bridge
// owns the cursor, because it owns the actions that move it.

let overlayEnabled = true;
let overlayBanner = true;

async function overlayCall(tab, body) {
  if (!overlayEnabled || !tab) return null;
  try {
    await browser.tabs.executeScript(tab.id, { file: '/overlay.js' });
    const banner = overlayBanner ? 'o.banner(true);' : 'o.banner(false);';
    const [result] = await browser.tabs.executeScript(tab.id, {
      code: `(() => { const o = window.__kloot_overlay; if (!o) return null; ${banner} ${body} })()`,
    });
    return result ?? null;
  } catch {
    // about:*, the PDF viewer and CSP-sandboxed documents refuse injection.
    // Losing the decoration must never fail the tool that asked for it.
    return null;
  }
}

// Long enough for the effect to be painted before the action it describes.
const OVERLAY_SETTLE_MS = 150;

function settle(ms = OVERLAY_SETTLE_MS) {
  return overlayEnabled ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// --- tools -----------------------------------------------------------------

const TOOLS = {
  async navigate(args) {
    if (args.url === 'back' || args.url === 'forward') {
      const tab = await resolveTab(args);
      await runInTab(tab, (dir) => history[dir === 'back' ? 'back' : 'forward'](), args.url);
      return textResult(`went ${args.url}`);
    }

    // Only bare hostnames get a scheme added. Testing for "://" would corrupt
    // schemes that do not use an authority component, such as data: or about:.
    const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`;
    let tab;
    if (typeof args.tabId === 'number') {
      tab = await browser.tabs.get(args.tabId);
      const loaded = waitForTopFrameLoad(tab.id);
      await browser.tabs.update(tab.id, { url });
      await loaded;
    } else {
      tab = await browser.tabs.create({ url, active: args.active ?? false });
      mcpTabs.add(tab.id);
      await waitForLoad(tab.id, { expectNavigation: true });
    }
    // A fresh document has no overlay, so mark the new page as supervised.
    await overlayCall(tab, 'return o.state();');
    const fresh = await browser.tabs.get(tab.id);
    return jsonResult({ navigated: true, ...describeTab(fresh) });
  },

  async tabs_context_mcp(args) {
    if (args.createIfEmpty && mcpTabs.size === 0) {
      const tab = await browser.tabs.create({ url: 'about:blank', active: false });
      mcpTabs.add(tab.id);
    }
    const tabs = [];
    for (const id of [...mcpTabs]) {
      try {
        tabs.push(describeTab(await browser.tabs.get(id)));
      } catch {
        mcpTabs.delete(id);
      }
    }
    return jsonResult({ tabs });
  },

  async tabs_create_mcp(args) {
    const tab = await browser.tabs.create({
      url: args.url ?? 'about:blank',
      active: args.active ?? false,
    });
    mcpTabs.add(tab.id);
    if (args.url) await waitForLoad(tab.id, { expectNavigation: true });
    return jsonResult(describeTab(await browser.tabs.get(tab.id)));
  },

  async tabs_close_mcp(args) {
    if (typeof args.tabId !== 'number') throw new Error('tabId is required');
    if (!mcpTabs.has(args.tabId)) {
      throw new Error(`Tab ${args.tabId} was not opened by this bridge; refusing to close it.`);
    }
    await browser.tabs.remove(args.tabId);
    mcpTabs.delete(args.tabId);
    return textResult(`closed tab ${args.tabId}`);
  },

  async get_page_text(args) {
    const tab = await resolveTab(args);
    const text = await runInTab(tab, () => {
      const article = document.querySelector('article, main, [role="main"]');
      return (article ?? document.body).innerText;
    });
    const limit = args.limit ?? 20000;
    return textResult(text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text);
  },

  async read_page(args) {
    const tab = await resolveTab(args);
    const snapshot = await runInTab(
      tab,
      (opts) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        };
        const label = (el) =>
          el.getAttribute('aria-label') ||
          el.labels?.[0]?.textContent?.trim() ||
          el.getAttribute('placeholder') ||
          el.name ||
          '';

        const forms = [...document.forms].map((form, index) => ({
          index,
          id: form.id || null,
          action: form.action || null,
          method: (form.method || 'GET').toUpperCase(),
          fields: [...form.elements]
            .filter((el) => el.type !== 'hidden' && el.type !== 'submit')
            .map((el) => ({
              name: el.name || null,
              type: el.type,
              label: label(el),
              value: el.type === 'password' ? '<redacted>' : el.type === 'checkbox' ? el.checked : el.value,
              disabled: el.disabled,
              visible: visible(el),
            })),
        }));

        const buttons = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
          .filter(visible)
          .slice(0, 100)
          .map((el) => ({ text: (el.innerText || el.value || '').trim().slice(0, 80), disabled: !!el.disabled }));

        const links = opts.includeLinks
          ? [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 200).map((a) => ({
              text: a.innerText.trim().slice(0, 80),
              href: a.href,
            }))
          : undefined;

        return {
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          forms,
          buttons,
          ...(links && { links }),
          text: opts.includeText ? document.body.innerText.slice(0, opts.textLimit) : undefined,
        };
      },
      {
        includeLinks: args.include_links ?? false,
        includeText: args.include_text ?? true,
        textLimit: args.text_limit ?? 4000,
      },
    );
    return jsonResult(snapshot);
  },

  async find(args) {
    const tab = await resolveTab(args);
    const matches = await runInTab(
      tab,
      (query) => {
        const needle = String(query).toLowerCase();
        const out = [];
        const els = document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link]');
        for (const el of els) {
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
          if (!text.toLowerCase().includes(needle)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          out.push({
            text: text.slice(0, 80),
            tag: el.tagName.toLowerCase(),
            center: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)],
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          });
          if (out.length >= 20) break;
        }
        return out;
      },
      args.query ?? args.text ?? '',
    );

    // Box every hit, numbered, so the window shows what was matched and in what
    // order the coordinates come back.
    const rects = matches.map((m, i) => ({ ...m.rect, label: `${i + 1}. ${m.tag}` }));
    await overlayCall(tab, `return o.highlight(${JSON.stringify(rects)}, { ttl: 4000 });`);

    // The rects were only needed for drawing; the caller works in centres.
    const trimmed = matches.map(({ rect, ...rest }) => rest);
    return jsonResult({ matches: trimmed, hint: 'Pass a center coordinate to the computer tool to click a match.' });
  },

  async form_input(args) {
    const tab = await resolveTab(args);
    const ok = await runInTab(
      tab,
      (input) => {
        const el = document.querySelector(input.selector);
        if (!el) return { ok: false, error: `no element matches ${input.selector}` };
        const r = el.getBoundingClientRect();
        if (el.type === 'checkbox' || el.type === 'radio') {
          el.checked = Boolean(input.value);
        } else {
          el.value = input.value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, type: el.type };
      },
      { selector: args.selector, value: args.value },
    );
    if (!ok.ok) throw new Error(ok.error);

    // Passwords are the one value that must not be echoed on screen.
    const shown = ok.type === 'password' ? '••••••••' : String(args.value ?? '');
    await overlayCall(
      tab,
      `o.cursor(${Math.round(ok.rect.x + ok.rect.width / 2)}, ${Math.round(ok.rect.y + ok.rect.height / 2)});
       o.highlight(${JSON.stringify([{ ...ok.rect, label: args.selector }])});
       return o.typing(${JSON.stringify(shown)});`,
    );
    return textResult(`set ${args.selector}`);
  },

  async javascript_tool(args) {
    const tab = await resolveTab(args);
    const result = await runInTab(tab, (code) => {
      try {
        // Wrapped so a bare expression still produces a value.
        const value = eval(`(()=>{${code.includes('return') ? code : `return (${code})`}})()`);
        return { ok: true, value: JSON.stringify(value ?? null) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }, args.code ?? args.script);
    if (!result.ok) throw new Error(result.error);
    return textResult(result.value);
  },

  async resize_window(args) {
    const tab = await resolveTab(args);
    await browser.windows.update(tab.windowId, {
      width: args.width ?? 1280,
      height: args.height ?? 900,
    });
    return textResult(`resized window to ${args.width ?? 1280}x${args.height ?? 900}`);
  },

  // Fallback only. The bridge normally serves this over BiDi with trusted
  // events; synthetic events are ignored by some sites, so the result says so.
  async computer(args) {
    const tab = await resolveTab(args);
    const [x, y] = Array.isArray(args.coordinate) ? args.coordinate : [args.x, args.y];

    if (args.action === 'screenshot') {
      await overlayCall(tab, 'return o.state();');
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: dataUrl.split(',')[1] } },
        ],
      };
    }

    if (args.action === 'type') {
      await overlayCall(tab, `return o.typing(${JSON.stringify(String(args.text ?? ''))});`);
    } else if (Number.isFinite(x) && Number.isFinite(y)) {
      await overlayCall(tab, `return o.press(${Math.round(x)}, ${Math.round(y)}, { button: 0 });`);
    }
    await settle();

    const outcome = await runInTab(
      tab,
      (act) => {
        const el = document.elementFromPoint(act.x, act.y);
        if (!el) return { ok: false, error: `no element at (${act.x}, ${act.y})` };
        if (act.action === 'type') {
          el.focus();
          if ('value' in el) {
            el.value = act.text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { ok: true };
        }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: act.x, clientY: act.y }));
        return { ok: true };
      },
      { action: args.action, x, y, text: args.text },
    );
    if (!outcome.ok) throw new Error(outcome.error);
    return textResult(
      `${args.action} dispatched as a synthetic event (isTrusted=false). Start Firefox with --remote-debugging-port for real input.`,
    );
  },

  // Runtime control of the visual feedback. The bridge intercepts this tool when
  // BiDi is up; this copy keeps it working in DOM-only mode.
  async overlay(args) {
    const action = args.action ?? 'status';
    const tab = await resolveTab(args).catch(() => null);

    if (action === 'on' || action === 'off') {
      overlayEnabled = action === 'on';
      if (typeof args.banner === 'boolean') overlayBanner = args.banner;
      if (action === 'off') {
        // overlayCall is a no-op once disabled, so tear down directly.
        if (tab) {
          await browser.tabs
            .executeScript(tab.id, { code: 'window.__kloot_overlay && window.__kloot_overlay.destroy()' })
            .catch(() => {});
        }
      } else {
        await overlayCall(tab, 'return o.state();');
      }
    } else if (action === 'clear') {
      await overlayCall(tab, 'return o.clear();');
    } else if (action !== 'status') {
      throw new Error(`unsupported overlay action: ${action} (expected on, off, clear or status)`);
    }

    const page = await overlayCall(tab, 'return o.state();');
    return jsonResult({ enabled: overlayEnabled, banner: overlayBanner, served_by: 'extension', page });
  },
};

// --- lifecycle -------------------------------------------------------------

browser.tabs.onRemoved.addListener((tabId) => mcpTabs.delete(tabId));

browser.storage.local
  .get('bridgeUrl')
  .then((stored) => {
    if (stored?.bridgeUrl) bridgeUrl = stored.bridgeUrl;
  })
  .catch(() => {})
  .finally(connect);
