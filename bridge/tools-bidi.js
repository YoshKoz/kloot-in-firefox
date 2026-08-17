'use strict';

// Tools served over WebDriver BiDi rather than by the extension.
//
// These are the ones a WebExtension genuinely cannot do: synthetic DOM events
// carry isTrusted=false and are ignored by many sites, and captureVisibleTab
// can only photograph the focused tab.

const overlay = require('./overlay');

const BIDI_TOOLS = new Set(['computer', 'read_console_messages', 'read_network_requests', 'overlay']);

// Ring buffers, filled by BiDi subscriptions once a tool asks for them.
const consoleLog = [];
const networkLog = [];
const MAX_ENTRIES = 500;
let capturing = false;

async function startCapture(bidi) {
  if (capturing) return;
  capturing = true;

  await bidi.subscribe(['log.entryAdded', 'network.responseCompleted']);

  bidi.on('log.entryAdded', (params) => {
    consoleLog.push({
      level: params.level,
      text: params.text,
      source: params.source?.realm,
      timestamp: params.timestamp,
      url: params.stackTrace?.callFrames?.[0]?.url,
    });
    if (consoleLog.length > MAX_ENTRIES) consoleLog.shift();
  });

  bidi.on('network.responseCompleted', (params) => {
    networkLog.push({
      url: params.request?.url,
      method: params.request?.method,
      status: params.response?.status,
      mimeType: params.response?.mimeType,
      fromCache: params.response?.fromCache,
      timestamp: params.timestamp,
    });
    if (networkLog.length > MAX_ENTRIES) networkLog.shift();
  });
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function imageResult(base64, note) {
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }];
  if (note) content.push({ type: 'text', text: note });
  return { content };
}

// The extension owns tab ids; BiDi owns context ids. When a tool names a tab we
// ask the extension for that tab's URL and join on it.
async function resolveContext(bidi, args, browser) {
  if (args.context) return args.context;

  if (typeof args.tabId === 'number' && browser) {
    const url = await askBrowser(browser, 'get_tab_url', { tabId: args.tabId });
    const ctx = await bidi.contextForUrl(url);
    if (ctx) return ctx;
  }
  return bidi.activeContext();
}

// Small request/response channel to the extension for metadata lookups.
let askSeq = 0;
const askPending = new Map();

function askBrowser(browser, method, params) {
  return new Promise((resolve, reject) => {
    const id = `ask-${++askSeq}`;
    const timer = setTimeout(() => {
      askPending.delete(id);
      reject(new Error(`extension did not answer ${method}`));
    }, 5000);

    askPending.set(id, { resolve, reject, timer });
    browser.send(JSON.stringify({ type: 'bridge_query', id, method, params }));
  });
}

// Called by the server when the extension replies to a bridge_query.
function resolveBrowserQuery(msg) {
  const entry = askPending.get(msg.id);
  if (!entry) return false;
  askPending.delete(msg.id);
  clearTimeout(entry.timer);
  entry.resolve(msg.result);
  return true;
}

async function handleBidiTool({ bidi, tool, args, browser }) {
  if (tool === 'read_console_messages') {
    await startCapture(bidi);
    const entries = args.pattern
      ? consoleLog.filter((e) => new RegExp(args.pattern, 'i').test(e.text ?? ''))
      : consoleLog;
    const slice = entries.slice(-(args.limit ?? 100));
    if (!slice.length) {
      return textResult('No console messages captured yet. Capture starts when this tool is first called — reload the page and try again.');
    }
    return textResult(slice.map((e) => `[${e.level}] ${e.text}`).join('\n'));
  }

  if (tool === 'read_network_requests') {
    await startCapture(bidi);
    const entries = args.pattern
      ? networkLog.filter((e) => new RegExp(args.pattern, 'i').test(e.url ?? ''))
      : networkLog;
    const slice = entries.slice(-(args.limit ?? 100));
    if (!slice.length) {
      return textResult('No network requests captured yet. Capture starts when this tool is first called — reload the page and try again.');
    }
    return textResult(slice.map((e) => `${e.status} ${e.method} ${e.url}`).join('\n'));
  }

  if (tool === 'overlay') {
    const context = await resolveContext(bidi, args, browser);
    const action = args.action ?? 'status';

    if (action === 'off' || action === 'on') {
      overlay.configure({ on: action === 'on', ...(typeof args.banner === 'boolean' && { banner: args.banner }) });
      if (action === 'off') await overlay.clear(bidi, context);
      else await overlay.refresh(bidi, context);
    } else if (action === 'clear') {
      await overlay.clear(bidi, context);
    } else if (action !== 'status') {
      throw new Error(`unsupported overlay action: ${action} (expected on, off, clear or status)`);
    }

    return textResult(JSON.stringify(await overlay.state(bidi, context), null, 1));
  }

  if (tool === 'computer') {
    const context = await resolveContext(bidi, args, browser);
    if (!context) throw new Error('no browsing context available');

    const action = args.action;
    const [x, y] = Array.isArray(args.coordinate) ? args.coordinate : [args.x, args.y];

    // Draw the pointer, target box and ripple first, then pause briefly so they
    // are actually on screen when the trusted input lands. For a bare
    // screenshot this only re-asserts the banner and the last cursor position.
    await overlay.beforeAction(bidi, context, action, {
      x,
      y,
      text: args.text ?? args.key,
      direction: args.scroll_direction,
      amount: args.scroll_amount,
    });

    switch (action) {
      case 'screenshot': {
        const data = await bidi.screenshot(context);
        return imageResult(data);
      }
      case 'left_click':
      case 'click':
        await bidi.click(context, x, y, 0);
        break;
      case 'right_click':
        await bidi.click(context, x, y, 2);
        break;
      case 'middle_click':
        await bidi.click(context, x, y, 1);
        break;
      case 'double_click':
        await bidi.doubleClick(context, x, y);
        break;
      case 'mouse_move':
        await bidi.moveMouse(context, x, y);
        break;
      case 'type':
        await bidi.typeText(context, args.text);
        break;
      case 'key':
        await bidi.pressKey(context, args.text ?? args.key);
        break;
      case 'scroll': {
        const dy = args.scroll_direction === 'up' ? -(args.scroll_amount ?? 3) * 100 : (args.scroll_amount ?? 3) * 100;
        const dx = args.scroll_direction === 'left' ? -(args.scroll_amount ?? 3) * 100
          : args.scroll_direction === 'right' ? (args.scroll_amount ?? 3) * 100 : 0;
        await bidi.scroll(context, x ?? 0, y ?? 0, dx, args.scroll_direction === 'up' || args.scroll_direction === 'down' ? dy : 0);
        break;
      }
      default:
        throw new Error(`unsupported computer action: ${action}`);
    }

    // Actions are far more useful with the resulting page state attached.
    await overlay.afterAction();
    const data = await bidi.screenshot(context);
    return imageResult(data, `action "${action}" completed`);
  }

  throw new Error(`tool ${tool} is not handled over BiDi`);
}

module.exports = { BIDI_TOOLS, handleBidiTool, resolveBrowserQuery };
