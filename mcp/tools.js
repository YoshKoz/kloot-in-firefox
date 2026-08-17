'use strict';

// The tool surface exposed over MCP.
//
// Deliberately not a 1:1 mapping of the bridge's tools. Two things are changed,
// both because the caller on the other end may be a small local model rather
// than a frontier one:
//
//   * `computer` is split into discrete verbs. One polymorphic tool with an
//     `action` enum and conditionally-required coordinates is a reliable way to
//     make an 8B model emit nonsense; `browser_click(x, y)` is not.
//   * tab ids never reach the caller. The server remembers the tab it is working
//     in, so the model cannot lose track of it or invent one.
//
// Results are kept short on purpose: an 8B model with an 8k window cannot afford
// a 20k-character page dump, and truncation here is cheaper than a blown context
// halfway through a task.

const { textOf, imageOf, jsonOf } = require('./bridge');

const PAGE_TEXT_LIMIT = Number(process.env.KLOOT_PAGE_LIMIT || 3000);
const FIND_LIMIT = 12;

function ok(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: false };
}

function fail(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

function clip(text, limit) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}\n…[truncated, ${s.length} chars total]` : s;
}

// Every tool goes through here so a bridge-level error becomes a readable
// sentence rather than a stack trace the model will choke on.
async function callBridge(ctx, tool, args) {
  const result = await ctx.bridge.call(tool, args);
  if (result.is_error) throw new Error(textOf(result) || `${tool} failed`);
  return result;
}

// Resolves the tab to act on, opening one if the caller never navigated.
async function currentTab(ctx) {
  if (ctx.state.tabId !== null) return ctx.state.tabId;
  const created = jsonOf(await callBridge(ctx, 'tabs_create_mcp', { url: 'about:blank', active: true }));
  ctx.state.tabId = created?.tabId ?? null;
  return ctx.state.tabId;
}

async function tabState(ctx, tabId) {
  const listed = jsonOf(await callBridge(ctx, 'tabs_context_mcp', {}));
  return (listed?.tabs ?? []).find((t) => t.tabId === tabId) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clicks and Enter presses routinely start a navigation, and the tool returns as
// soon as the input is delivered — so a caller that immediately reads the page
// gets the document it just left. That produces confidently wrong answers, which
// is worse than a slow tool, so an action that might navigate waits to see.
//
// Reports the destination when the page moved, giving the caller an explicit
// signal instead of leaving it to guess.
async function settle(ctx, tabId, before, maxMs = 6000) {
  const deadline = Date.now() + maxMs;
  let moved = false;

  while (Date.now() < deadline) {
    await sleep(200);
    const now = await tabState(ctx, tabId);
    if (!now) break;
    if (now.url !== before?.url) moved = true;
    // Settled: loading finished and either nothing moved or the new page is in.
    if (now.status === 'complete') {
      if (moved) return `\npage navigated to ${now.url}\nnew title: ${now.title}`;
      // Give a same-document click a moment to start something before declaring
      // it inert, but do not burn the whole budget on it.
      if (Date.now() > deadline - maxMs + 1200) return '';
    }
  }
  const final = await tabState(ctx, tabId);
  return moved && final ? `\npage navigated to ${final.url}\nnew title: ${final.title}` : '';
}

const TOOLS = [
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the browser and wait for it to finish loading. Returns the page title and final URL. ' +
      'Use "back" or "forward" as the url to move through history.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A URL, or "back" / "forward".' } },
      required: ['url'],
    },
    async run(ctx, args) {
      const first = ctx.state.tabId === null;
      const result = jsonOf(
        await callBridge(ctx, 'navigate', {
          url: args.url,
          // Reuse the tab once we have one, so a task does not litter the window.
          ...(first ? { active: true } : { tabId: ctx.state.tabId }),
        }),
      );
      if (result?.tabId != null) ctx.state.tabId = result.tabId;
      if (!result) return ok('navigated');
      return ok(`title: ${result.title}\nurl: ${result.url}\nstatus: ${result.status}`);
    },
  },

  {
    name: 'browser_read_page',
    description:
      'Describe the current page structure: its title, forms and their fields with labels, and buttons. ' +
      'Use this to learn what can be interacted with before clicking anything.',
    inputSchema: {
      type: 'object',
      properties: {
        include_links: { type: 'boolean', description: 'Also list the links on the page.' },
      },
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      const page = jsonOf(
        await callBridge(ctx, 'read_page', {
          tabId,
          include_links: Boolean(args.include_links),
          include_text: false,
        }),
      );
      if (!page) return ok('(no snapshot)');

      const lines = [`title: ${page.title}`, `url: ${page.url}`];
      for (const form of page.forms ?? []) {
        lines.push(`form ${form.index} (${form.method} ${form.action ?? ''}):`);
        for (const f of form.fields ?? []) {
          lines.push(`  - ${f.type} name=${f.name ?? '?'} label=${JSON.stringify(f.label ?? '')}` +
            `${f.value ? ` value=${JSON.stringify(String(f.value).slice(0, 40))}` : ''}`);
        }
      }
      const buttons = (page.buttons ?? []).filter((b) => b.text).slice(0, 20);
      if (buttons.length) lines.push(`buttons: ${buttons.map((b) => JSON.stringify(b.text)).join(', ')}`);
      const links = (page.links ?? []).slice(0, 25);
      if (links.length) lines.push(`links:\n${links.map((l) => `  - ${JSON.stringify(l.text)} -> ${l.href}`).join('\n')}`);

      return ok(clip(lines.join('\n'), PAGE_TEXT_LIMIT));
    },
  },

  {
    name: 'browser_get_text',
    description:
      'Read the visible text of the current page. Use this to actually read content, for example search results ' +
      'or an article, after navigating.',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      const tabId = await currentTab(ctx);
      const text = textOf(await callBridge(ctx, 'get_page_text', { tabId, limit: PAGE_TEXT_LIMIT }));
      return ok(clip(text, PAGE_TEXT_LIMIT));
    },
  },

  {
    name: 'browser_find',
    description:
      'Find clickable things on the page whose text matches a query, and get the exact x,y coordinates to click. ' +
      'Always use this to get coordinates instead of guessing them. Each match is also boxed on screen.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to look for, e.g. "Search" or "Sign in".' } },
      required: ['query'],
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      const found = jsonOf(await callBridge(ctx, 'find', { tabId, query: args.query }));
      const matches = (found?.matches ?? []).slice(0, FIND_LIMIT);
      if (!matches.length) return ok(`no matches for ${JSON.stringify(args.query)}`);
      return ok(
        `${matches.length} match(es):\n` +
          matches.map((m, i) => `  ${i + 1}. <${m.tag}> ${JSON.stringify(m.text)} at x=${m.center[0]} y=${m.center[1]}`).join('\n'),
      );
    },
  },

  {
    name: 'browser_click',
    description:
      'Click something on the page with a real mouse event. Give the visible text of what you want to click, ' +
      'for example text "Learn more" or text "Sign in". The element is located for you. ' +
      'Only pass x and y instead if you already have exact coordinates from browser_find.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text of the element to click. Preferred over x/y.' },
        x: { type: 'number', description: 'Only if you have exact coordinates.' },
        y: { type: 'number', description: 'Only if you have exact coordinates.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Defaults to left.' },
      },
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      const action = { left: 'left_click', right: 'right_click', middle: 'middle_click' }[args.button ?? 'left'];

      let x = args.x;
      let y = args.y;
      let what = `${x},${y}`;

      // Resolving the target here rather than making the caller chain find→click
      // removes the failure this tool used to invite: models skip the find step
      // and click a plausible-looking coordinate, which silently hits nothing.
      if (args.text != null && String(args.text).trim()) {
        const found = jsonOf(await callBridge(ctx, 'find', { tabId, query: String(args.text) }));
        const match = (found?.matches ?? [])[0];
        if (!match) {
          const page = jsonOf(await callBridge(ctx, 'read_page', { tabId, include_links: true, include_text: false }));
          const options = [
            ...(page?.buttons ?? []).map((b) => b.text),
            ...(page?.links ?? []).map((l) => l.text),
          ].filter(Boolean).slice(0, 15);
          return fail(
            `nothing clickable matches ${JSON.stringify(args.text)}.` +
              (options.length ? ` Clickable text on this page: ${options.map((o) => JSON.stringify(o)).join(', ')}` : ''),
          );
        }
        [x, y] = match.center;
        what = `<${match.tag}> ${JSON.stringify(String(match.text).slice(0, 60))} at ${x},${y}`;
      }

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return fail('give either text (preferred) or both x and y.');
      }

      const before = await tabState(ctx, tabId);
      await callBridge(ctx, 'computer', { action, coordinate: [x, y], tabId });
      return ok(`clicked ${what}${await settle(ctx, tabId, before)}`);
    },
  },

  {
    name: 'browser_type',
    description:
      'Type text with real key events into whatever is focused. Click the field first. ' +
      'This does not press Enter — use browser_press_key for that.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      await callBridge(ctx, 'computer', { action: 'type', text: args.text, tabId });
      return ok(`typed ${JSON.stringify(args.text)}`);
    },
  },

  {
    name: 'browser_press_key',
    description: 'Press a key or chord with a real key event, for example "Enter", "Tab", "Escape", "Control+a".',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      const before = await tabState(ctx, tabId);
      await callBridge(ctx, 'computer', { action: 'key', text: args.key, tabId });
      // Enter on a form is the other common way to start a navigation.
      const moved = /^enter$|^numpadenter$/i.test(String(args.key).trim())
        ? await settle(ctx, tabId, before)
        : '';
      return ok(`pressed ${args.key}${moved}`);
    },
  },

  {
    name: 'browser_scroll',
    description: 'Scroll the page. Use this to reach content below the fold before reading it.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Notches to scroll, default 3.' },
      },
      required: ['direction'],
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      await callBridge(ctx, 'computer', {
        action: 'scroll',
        coordinate: [600, 400],
        scroll_direction: args.direction,
        scroll_amount: args.amount ?? 3,
        tabId,
      });
      return ok(`scrolled ${args.direction}`);
    },
  },

  {
    name: 'browser_fill_field',
    description:
      'Set a form field directly by CSS selector, without clicking or typing. Faster and more reliable than ' +
      'click-then-type when you already know the selector from browser_read_page.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'A CSS selector, e.g. "#email" or "input[name=q]".' },
        value: { type: 'string' },
      },
      required: ['selector', 'value'],
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      await callBridge(ctx, 'form_input', { tabId, selector: args.selector, value: args.value });
      return ok(`set ${args.selector}`);
    },
  },

  {
    name: 'browser_screenshot',
    description:
      'Take a screenshot of the page. Only useful to a caller that can look at images — prefer ' +
      'browser_read_page and browser_get_text for deciding what to do.',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      const tabId = await currentTab(ctx);
      const result = await callBridge(ctx, 'computer', { action: 'screenshot', tabId });
      const img = imageOf(result);
      if (!img) return fail('no image returned');
      return {
        content: [{ type: 'image', data: img.source.data, mimeType: img.source.media_type ?? 'image/png' }],
        isError: false,
      };
    },
  },

  {
    name: 'browser_tabs',
    description: 'List the tabs this automation has opened, and which one is currently being driven.',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      const listed = jsonOf(await callBridge(ctx, 'tabs_context_mcp', {}));
      const tabs = listed?.tabs ?? [];
      if (!tabs.length) return ok('no tabs open yet');
      return ok(
        tabs
          .map((t) => `${t.tabId === ctx.state.tabId ? '* ' : '  '}tab ${t.tabId}: ${t.title} — ${t.url}`)
          .join('\n'),
      );
    },
  },

  {
    name: 'browser_close_tab',
    description: 'Close the tab being driven. Only tabs this automation opened can be closed.',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      if (ctx.state.tabId === null) return ok('no tab to close');
      const id = ctx.state.tabId;
      await callBridge(ctx, 'tabs_close_mcp', { tabId: id });
      ctx.state.tabId = null;
      return ok(`closed tab ${id}`);
    },
  },

  {
    name: 'browser_console',
    description: 'Read console messages from the page. Capture starts the first time this is called.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional case-insensitive filter.' },
        limit: { type: 'number' },
      },
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      const text = textOf(await callBridge(ctx, 'read_console_messages', {
        tabId,
        ...(args.pattern && { pattern: args.pattern }),
        limit: args.limit ?? 40,
      }));
      return ok(clip(text, PAGE_TEXT_LIMIT));
    },
  },

  {
    name: 'browser_network',
    description: 'Read network requests the page made. Capture starts the first time this is called.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Optional case-insensitive URL filter.' },
        limit: { type: 'number' },
      },
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      const text = textOf(await callBridge(ctx, 'read_network_requests', {
        tabId,
        ...(args.pattern && { pattern: args.pattern }),
        limit: args.limit ?? 40,
      }));
      return ok(clip(text, PAGE_TEXT_LIMIT));
    },
  },

  {
    name: 'browser_overlay',
    description:
      'Control the on-page visual feedback (the pointer, target boxes and banner that show what is being driven). ' +
      'Use "off" to stop drawing, "status" to check it.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['on', 'off', 'clear', 'status'] } },
      required: ['action'],
    },
    async run(ctx, args) {
      const tabId = await currentTab(ctx);
      const text = textOf(await callBridge(ctx, 'overlay', { action: args.action, tabId }));
      return ok(clip(text, 600));
    },
  },
];

// The subset worth giving to a small local model: text-driven, no images, no
// protocol capture. Fewer, sharper tools beat a complete catalogue.
const AGENT_TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_read_page',
  'browser_get_text',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_fill_field',
]);

module.exports = { TOOLS, AGENT_TOOL_NAMES, ok, fail };
