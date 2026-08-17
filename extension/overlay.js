'use strict';

// On-page visual feedback for automated actions: the pointer that glides to each
// target, the click ripple, the box around whatever is about to be hit, the
// keystrokes being typed, and the banner saying the tab is being driven.
//
// This file is injected from two places, so it must be safe to run repeatedly:
//
//   * the bridge evaluates it over BiDi, in the page's main world
//   * the extension injects it with tabs.executeScript, in its isolated world
//
// Those two worlds have separate `window` objects but share a single DOM, so all
// state lives on the container element and its (open) shadow root rather than on
// `window`. Whichever world runs first builds the nodes; the other finds and
// reuses them instead of stacking a second cursor on top.
//
// Everything is `pointer-events: none` and lives outside `<body>` in a shadow
// root, so it cannot swallow the trusted click that follows it and cannot leak
// into `read_page`, `find` or `get_page_text`, none of which cross a shadow
// boundary.

(() => {
  const VERSION = '1';
  const ROOT_ID = '__kloot_overlay_root';
  const ACCENT = '#d97757';

  // Page CSS is hostile by default: a stray `div { position: static }` or a
  // low-specificity `* { display: none }` would break the overlay, so the host's
  // own geometry is set inline and forced.
  const HOST_CSS = [
    'position:fixed', 'left:0', 'top:0', 'width:100%', 'height:100%',
    'margin:0', 'padding:0', 'border:0', 'background:transparent',
    'pointer-events:none', 'z-index:2147483647', 'display:block',
    'opacity:1', 'visibility:visible', 'transform:none', 'filter:none',
    'clip:auto', 'contain:none', 'mix-blend-mode:normal',
  ].map((rule) => `${rule} !important`).join(';');

  const SHADOW_CSS = `
    * { box-sizing: border-box; }
    .fx {
      position: absolute;
      pointer-events: none;
      font: 500 11px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #fff;
    }
    [hidden] { display: none !important; }

    /* The tip of the arrow sits exactly on the requested coordinate, so the
       glide animation reads as the pointer travelling to its target. */
    #cursor {
      left: 0; top: 0; width: 17px; height: 27px;
      transition: transform .13s cubic-bezier(.22,.61,.36,1);
      filter: drop-shadow(0 1px 2px rgba(0,0,0,.45));
      z-index: 6;
    }
    #cursor svg { display: block; width: 17px; height: 27px; }

    #ring, #ring2 {
      width: 14px; height: 14px; margin: -7px 0 0 -7px;
      border: 2px solid ${ACCENT}; border-radius: 50%;
      opacity: 0; z-index: 5;
    }
    #ring.go  { animation: ripple .55s ease-out forwards; }
    #ring2.go { animation: ripple .55s .12s ease-out forwards; }
    @keyframes ripple {
      from { transform: scale(.4); opacity: .95; }
      to   { transform: scale(3.6); opacity: 0; }
    }

    #dot {
      width: 10px; height: 10px; margin: -5px 0 0 -5px;
      background: ${ACCENT}; border-radius: 50%;
      box-shadow: 0 0 0 3px rgba(217,119,87,.3);
      opacity: 0; z-index: 5;
    }
    #dot.go { animation: pop .5s ease-out forwards; }
    @keyframes pop {
      from { transform: scale(.2); opacity: 1; }
      60%  { transform: scale(1.15); opacity: 1; }
      to   { transform: scale(1); opacity: 0; }
    }

    .box {
      position: absolute;
      border: 2px solid ${ACCENT};
      border-radius: 3px;
      background: rgba(217,119,87,.10);
      box-shadow: 0 0 0 1px rgba(0,0,0,.25);
      z-index: 4;
    }
    .box > span {
      position: absolute; left: -2px; top: -18px;
      max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 1px 5px; border-radius: 3px 3px 0 0;
      background: ${ACCENT}; color: #fff;
      font: 500 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    /* A box hugging the top edge would push its label off-screen. */
    .box.below > span { top: 100%; border-radius: 0 0 3px 3px; }

    #bubble {
      max-width: 340px; padding: 5px 8px;
      background: rgba(24,24,27,.94); border: 1px solid rgba(255,255,255,.14);
      border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
      font: 500 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap; word-break: break-word;
      z-index: 7;
    }
    #bubble b { color: ${ACCENT}; font-weight: 600; }

    #banner {
      left: 50%; top: 10px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 6px;
      padding: 5px 11px 5px 9px;
      background: rgba(24,24,27,.9); border: 1px solid rgba(217,119,87,.55);
      border-radius: 999px; box-shadow: 0 3px 12px rgba(0,0,0,.32);
      letter-spacing: .01em; z-index: 8;
    }
    #banner i {
      width: 7px; height: 7px; border-radius: 50%;
      background: ${ACCENT}; animation: breathe 1.8s ease-in-out infinite;
    }
    @keyframes breathe { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

    #frame {
      left: 0; top: 0; width: 100%; height: 100%;
      box-shadow: inset 0 0 0 2px rgba(217,119,87,.42);
      z-index: 3;
    }

    @media (prefers-reduced-motion: reduce) {
      #cursor { transition: none; }
      #ring, #ring2, #dot, #banner i { animation-duration: .01ms !important; }
    }
  `;

  // A classic arrow, drawn so its tip is the path origin.
  const CURSOR_SVG =
    '<svg viewBox="0 0 12 19" aria-hidden="true">' +
    '<path d="M0,0 L0,16 L4,12 L6.5,18 L9,17 L6.5,11 L12,11 Z" ' +
    'fill="#fff" stroke="#18181b" stroke-width="1.1" stroke-linejoin="round"/>' +
    '</svg>';

  function build() {
    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.setAttribute('style', HOST_CSS);
    host.dataset.klootVersion = VERSION;

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      `<style>${SHADOW_CSS}</style>` +
      '<div class="fx" id="frame" hidden></div>' +
      '<div class="fx" id="banner" hidden><i></i><span id="bannerText"></span></div>' +
      '<div id="boxes"></div>' +
      '<div class="fx" id="ring"></div>' +
      '<div class="fx" id="ring2"></div>' +
      '<div class="fx" id="dot"></div>' +
      '<div class="fx" id="bubble" hidden></div>' +
      `<div class="fx" id="cursor" hidden>${CURSOR_SVG}</div>`;

    // documentElement rather than body: body can be absent while the document is
    // still parsing, and some frameworks replace it wholesale on hydration.
    (document.documentElement || document.body).appendChild(host);
    return host;
  }

  function hostElement() {
    const existing = document.getElementById(ROOT_ID);
    if (!existing) return build();

    // A stale build from an older version of this file cannot be reused safely.
    if (existing.dataset.klootVersion !== VERSION || !existing.shadowRoot) {
      existing.remove();
      return build();
    }
    // Re-assert geometry in case the page mangled the style attribute, and
    // re-attach if a router wiped documentElement's children.
    existing.setAttribute('style', HOST_CSS);
    if (!existing.isConnected) (document.documentElement || document.body).appendChild(existing);
    return existing;
  }

  const host = hostElement();
  const shadow = host.shadowRoot;
  const $ = (id) => shadow.getElementById(id);

  // Timers are keyed by element so a second action cancels the first one's
  // pending hide instead of letting it cut the new one short.
  const timers = new Map();
  function hideAfter(el, ms) {
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => { el.hidden = true; }, ms));
  }

  function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // force a reflow so the animation replays
    el.classList.add(cls);
  }

  function place(el, x, y) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  function describe(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const text = (el.getAttribute('aria-label') || el.innerText || el.value || '')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? `${tag} · ${text.slice(0, 60)}` : tag;
  }

  const api = {
    version: VERSION,

    // Called before every action: cheap when nothing has changed, and the only
    // thing needed to bring the overlay back after a navigation.
    reattach() {
      const x = Number(host.dataset.cursorX);
      const y = Number(host.dataset.cursorY);
      if (Number.isFinite(x) && Number.isFinite(y) && host.dataset.cursorShown === '1') {
        api.cursor(x, y, { animate: false });
      }
      if (host.dataset.banner === '1') api.banner(true, host.dataset.bannerText || undefined);
      return true;
    },

    cursor(x, y, { animate = true } = {}) {
      const el = $('cursor');
      const cx = clamp(Number(x) || 0, 0, Math.max(0, innerWidth - 2));
      const cy = clamp(Number(y) || 0, 0, Math.max(0, innerHeight - 2));
      if (!animate) el.style.transition = 'none';
      el.hidden = false;
      el.style.transform = `translate(${cx}px, ${cy}px)`;
      if (!animate) {
        void el.offsetWidth;
        el.style.transition = '';
      }
      host.dataset.cursorX = String(cx);
      host.dataset.cursorY = String(cy);
      host.dataset.cursorShown = '1';
      return { x: cx, y: cy };
    },

    // Draws the boxes for a list of viewport rects. Used both for the element
    // about to be clicked and for everything `find` matched.
    highlight(rects, { ttl = 2200 } = {}) {
      const boxes = $('boxes');
      boxes.textContent = '';
      for (const r of rects || []) {
        const box = document.createElement('div');
        box.className = 'box';
        box.style.left = `${Math.round(r.x)}px`;
        box.style.top = `${Math.round(r.y)}px`;
        box.style.width = `${Math.max(2, Math.round(r.width))}px`;
        box.style.height = `${Math.max(2, Math.round(r.height))}px`;
        if (r.label) {
          if (r.y < 20) box.classList.add('below');
          const tag = document.createElement('span');
          tag.textContent = r.label;
          box.appendChild(tag);
        }
        boxes.appendChild(box);
      }
      clearTimeout(timers.get(boxes));
      if (ttl > 0) timers.set(boxes, setTimeout(() => { boxes.textContent = ''; }, ttl));
      return (rects || []).length;
    },

    // Highlights whatever is under a point. The overlay is pointer-events:none,
    // so elementFromPoint returns the real page element, not our own nodes.
    highlightPoint(x, y, opts) {
      const el = document.elementFromPoint(x, y);
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return api.highlight([{ x: r.x, y: r.y, width: r.width, height: r.height, label: describe(el) }], opts);
    },

    // Cursor + target box + ripple, in one call, for a click about to happen.
    press(x, y, { button = 0, double = false, highlight = true } = {}) {
      const at = api.cursor(x, y);
      if (highlight) api.highlightPoint(at.x, at.y);
      place($('ring'), at.x, at.y);
      place($('ring2'), at.x, at.y);
      place($('dot'), at.x, at.y);
      restart($('ring'), 'go');
      if (double) restart($('ring2'), 'go'); else $('ring2').classList.remove('go');
      restart($('dot'), 'go');
      if (button === 2) api.bubble('right click', { ttl: 1200 });
      else if (button === 1) api.bubble('middle click', { ttl: 1200 });
      return at;
    },

    // Text bubble anchored just below-right of the cursor, flipped when it would
    // run off the viewport.
    bubble(html, { ttl = 2600 } = {}) {
      const el = $('bubble');
      el.innerHTML = html;
      el.hidden = false;
      const cx = Number(host.dataset.cursorX) || 12;
      const cy = Number(host.dataset.cursorY) || 12;
      // Measure after it is visible, otherwise the rect is empty.
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = cx + 20 + w > innerWidth ? Math.max(4, cx - 20 - w) : cx + 20;
      const top = cy + 24 + h > innerHeight ? Math.max(4, cy - 8 - h) : cy + 24;
      place(el, left, top);
      hideAfter(el, ttl);
      return true;
    },

    typing(text) {
      const shown = String(text ?? '');
      const safe = shown.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const clipped = safe.length > 160 ? `${safe.slice(0, 160)}…` : safe;
      return api.bubble(`<b>type</b> ${clipped || '<i>(empty)</i>'}`);
    },

    keys(text) {
      const safe = String(text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      return api.bubble(`<b>key</b> ${safe}`);
    },

    scrollHint(x, y, direction, amount) {
      const at = api.cursor(x, y);
      const arrow = { up: '↑', down: '↓', left: '←', right: '→' }[direction] || '↕';
      place($('dot'), at.x, at.y);
      restart($('dot'), 'go');
      return api.bubble(`<b>scroll</b> ${arrow} ${amount ?? ''}`.trim(), { ttl: 1600 });
    },

    banner(on, text) {
      const banner = $('banner');
      const frame = $('frame');
      if (!on) {
        banner.hidden = true;
        frame.hidden = true;
        host.dataset.banner = '0';
        return false;
      }
      const label = text || 'Claude is controlling this tab';
      $('bannerText').textContent = label;
      banner.hidden = false;
      frame.hidden = false;
      host.dataset.banner = '1';
      host.dataset.bannerText = label;
      return true;
    },

    // Clears the transient effects but keeps the overlay installed.
    clear() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      $('boxes').textContent = '';
      $('bubble').hidden = true;
      $('cursor').hidden = true;
      $('ring').classList.remove('go');
      $('ring2').classList.remove('go');
      $('dot').classList.remove('go');
      host.dataset.cursorShown = '0';
      return true;
    },

    destroy() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      host.remove();
      try { delete window.__kloot_overlay; } catch { window.__kloot_overlay = undefined; }
      return true;
    },

    state() {
      return {
        version: VERSION,
        installed: host.isConnected,
        cursor: host.dataset.cursorShown === '1'
          ? { x: Number(host.dataset.cursorX), y: Number(host.dataset.cursorY) }
          : null,
        banner: host.dataset.banner === '1',
        boxes: $('boxes').childElementCount,
      };
    },
  };

  window.__kloot_overlay = api;
  api.reattach();
  return true;
})();
