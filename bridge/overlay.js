'use strict';

// Bridge half of the visual overlay.
//
// The `computer` tool is served here rather than in the extension, so the
// pointer, ripple and target box for a trusted action have to be drawn from
// here too. The renderer itself lives in ../extension/overlay.js — one copy,
// shared — and is evaluated into the page's main world over BiDi.
//
// Every call re-sends the renderer. That looks wasteful but it is what makes the
// overlay survive navigation: the script is idempotent and reuses the existing
// nodes when they are already there, so a re-send is either a no-op or the
// repair that puts the cursor back after the document was replaced.
//
// None of this is allowed to break a tool call. Pages that refuse script
// evaluation (about:*, PDF viewer, a CSP-sandboxed frame) simply get no
// overlay, and the action proceeds as if the feature were switched off.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'overlay.js'), 'utf8');

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// Wrapped in a function so the whole thing is a single expression with a
// well-defined completion value, which is what script.evaluate wants.
function expression(body) {
  return `(() => {
${SOURCE}
const o = window.__kloot_overlay;
if (!o) return null;
${body}
})()`;
}

let enabled = config.overlay;
let bannerEnabled = config.overlayBanner;

// Where the pointer was left in each context. The overlay itself keeps this on
// the host element's dataset, but that dies with the document, so the surviving
// copy has to be here for the cursor to reappear in the same place after a
// navigation.
const lastCursor = new Map();

// BiDi hands back a tagged tree rather than a plain value — objects arrive as
// {type:'object', value:[[key, node], ...]} — so anything destined for a tool
// result has to be turned back into ordinary JS first.
function fromRemote(node) {
  if (!node || typeof node !== 'object') return node ?? null;
  switch (node.type) {
    case 'undefined':
    case 'null':
      return null;
    case 'array':
    case 'set':
      return (node.value ?? []).map(fromRemote);
    case 'object':
    case 'map':
      return Object.fromEntries((node.value ?? []).map(([k, v]) => [fromRemote(k), fromRemote(v)]));
    default:
      return node.value ?? null;
  }
}

// Runs overlay statements in a context. `body` may use `o` as the overlay API.
async function run(bidi, context, body) {
  if (!enabled || !context || !bidi?.connected) return null;
  try {
    const result = await bidi.evaluate(context, expression(body));
    return fromRemote(result?.result);
  } catch {
    return null; // never let decoration fail an action
  }
}

function bannerStatement() {
  return bannerEnabled ? 'o.banner(true);' : 'o.banner(false);';
}

// Puts the pointer back where it was, for actions that do not move it
// themselves. Harmless when the overlay already has it in that spot.
function restoreStatement(context) {
  const at = lastCursor.get(context);
  return at ? `o.cursor(${at.x}, ${at.y}, { animate: false });` : '';
}

// Draws the visual for an action, then waits long enough for it to be on screen
// before the real input is delivered.
async function beforeAction(bidi, context, action, { x, y, text, direction, amount } = {}) {
  if (!enabled) return;

  const hasPoint = Number.isFinite(x) && Number.isFinite(y);
  const at = hasPoint ? `${Math.round(x)}, ${Math.round(y)}` : null;
  if (hasPoint) lastCursor.set(context, { x: Math.round(x), y: Math.round(y) });
  let body;

  switch (action) {
    case 'left_click':
    case 'click':
      body = at && `o.press(${at}, { button: 0 });`;
      break;
    case 'right_click':
      body = at && `o.press(${at}, { button: 2 });`;
      break;
    case 'middle_click':
      body = at && `o.press(${at}, { button: 1 });`;
      break;
    case 'double_click':
      body = at && `o.press(${at}, { button: 0, double: true });`;
      break;
    case 'mouse_move':
      body = at && `o.cursor(${at}); o.highlightPoint(${at});`;
      break;
    case 'type':
      body = `o.typing(${JSON.stringify(String(text ?? ''))});`;
      break;
    case 'key':
      body = `o.keys(${JSON.stringify(String(text ?? ''))});`;
      break;
    case 'scroll':
      body = `o.scrollHint(${at || '0, 0'}, ${JSON.stringify(direction ?? 'down')}, ${JSON.stringify(String(amount ?? ''))});`;
      break;
    default:
      body = null;
  }

  // Actions that do not carry a coordinate (type, key, screenshot) still want the
  // pointer visible where the last one left it.
  const restore = hasPoint ? '' : restoreStatement(context);
  await run(bidi, context, `${bannerStatement()} ${restore} ${body ?? ''} return o.state();`);
  if (body) await sleep(config.overlayDelayMs);
}

// A short settle after the action so the ripple is still mid-flight in the
// screenshot that gets attached to the result.
async function afterAction() {
  if (enabled) await sleep(Math.min(config.overlayDelayMs, 140));
}

// Re-asserts the overlay without drawing anything new. Used by tools that are
// not actions but still want the tab to look supervised.
async function refresh(bidi, context) {
  return run(bidi, context, `${bannerStatement()} ${restoreStatement(context)} return o.state();`);
}

async function state(bidi, context) {
  if (!enabled) return { enabled: false };
  const s = await run(bidi, context, 'return o.state();');
  return { enabled: true, banner: bannerEnabled, page: s };
}

async function clear(bidi, context) {
  lastCursor.delete(context);
  // destroy() has to run even when the feature was just switched off, so this
  // deliberately bypasses run()'s enabled check.
  if (!context || !bidi?.connected) return null;
  return bidi
    .evaluate(context, 'window.__kloot_overlay ? window.__kloot_overlay.destroy() : false')
    .then((r) => fromRemote(r?.result))
    .catch(() => null);
}

function configure({ on, banner } = {}) {
  if (typeof on === 'boolean') enabled = on;
  if (typeof banner === 'boolean') bannerEnabled = banner;
  return { enabled, banner: bannerEnabled };
}

module.exports = {
  beforeAction,
  afterAction,
  refresh,
  clear,
  state,
  configure,
  sleep,
  get enabled() {
    return enabled;
  },
};
