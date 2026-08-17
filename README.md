# kloot-in-firefox

Browser automation for Claude Code, running against Firefox instead of Chrome.

Claude Code can drive a browser through a local WebSocket bridge (the mode it
uses when `LOCAL_BRIDGE=1` is set). This project provides the two halves that
mode needs: a relay that Claude Code connects to, and a Firefox extension that
carries out the tool calls.

Nothing here talks to Anthropic's servers. The relay listens on loopback only.

## Design

```
Claude Code  ──ws──►  bridge (this repo)  ──ws──►  Firefox extension
                            │
                            └──WebDriver BiDi──►  Firefox (debugging mode)
```

The extension handles everything the WebExtensions APIs do well: tabs,
navigation, page reading, form filling, script evaluation.

Three things a WebExtension genuinely cannot do — trusted input events,
screenshots of a specific tab, and protocol-level console/network capture — are
served over **WebDriver BiDi** instead. That is what "debugging mode" buys:
synthetic DOM events carry `isTrusted=false` and many sites ignore them, while
BiDi input is indistinguishable from a real person.

If Firefox was not started with remote debugging the bridge still works; the
`computer` tool falls back to synthetic events and says so in its result.

## Requirements

- Firefox (tested on Nightly 156)
- Node.js (tested on 26)

## Setup

```sh
cd bridge && npm install
```

### 1. Start Firefox in debugging mode

```sh
./scripts/launch-firefox.sh
```

This uses a dedicated profile under `~/.local/share/kloot-in-firefox/profile`, so
remote debugging is never enabled on your everyday browsing profile. Override
with `FIREFOX=`, `KLOOT_BIDI_PORT=`, `KLOOT_PROFILE=`.

### 2. Install the extension

Temporarily, into the running Firefox:

```sh
node bridge/install-extension.js
```

Permanently, load `kloot-in-firefox.xpi` (built with `./scripts/build-xpi.sh`)
via `about:addons`. Unsigned extensions require Nightly with
`xpinstall.signatures.required=false`, or load the `extension/` directory from
`about:debugging` for a temporary install.

### 3. Start the bridge

```sh
node bridge/server.js
```

### 4. Point Claude Code at it

```sh
LOCAL_BRIDGE=1 claude
```

## Port 8765

Claude Code hardcodes `ws://localhost:8765` in local-bridge mode, so the bridge
must own that port for Claude Code to find it. `KLOOT_PORT` exists only for
testing — changing it means Claude Code can no longer connect.

If something else already holds 8765, stop that service first. On this machine
`~/.claudecodebrowser/mcp-server/server.py` uses the same port.

## Tools

Served by the extension:

| Tool | Notes |
|---|---|
| `navigate` | Also accepts `back` / `forward`; waits for the real page to load |
| `tabs_context_mcp` | Lists only tabs this bridge opened |
| `tabs_create_mcp` / `tabs_close_mcp` | Refuses to close tabs it does not own |
| `get_page_text` | Article text where detectable, else full body |
| `read_page` | Forms, fields, buttons, optional links and text |
| `find` | Locates clickable elements by text, returns click coordinates |
| `form_input` | Sets a value and fires `input`/`change` |
| `javascript_tool` | Evaluates an expression in the page |
| `resize_window` | |

Served over BiDi:

| Tool | Notes |
|---|---|
| `computer` | screenshot, click, double/right/middle click, move, type, key, scroll |
| `read_console_messages` | Capture begins on first call |
| `read_network_requests` | Capture begins on first call |
| `overlay` | `on` / `off` / `clear` / `status` for the visual feedback below |

Tabs are scoped: `tabs_*_mcp` only ever sees or closes tabs this bridge created,
so automation cannot disturb the tabs a person is using.

## Visual feedback

Automation is otherwise invisible: the page just changes and there is no way to
tell what was aimed at or whether the click went where it was meant to. So every
action draws itself first.

- a **pointer** that glides to the target and stays where it was left, so the
  screenshot attached to a result shows what was just touched
- a **box** around the element about to be hit, labelled with its tag and text
- a **ripple** at the click point
- a **bubble** showing text being typed or the key chord being pressed —
  `password` fields are masked, never echoed
- numbered boxes over **every `find` match**, in the order the coordinates are
  returned
- a **banner** and frame while the tab is under control

The `overlay` tool controls it at runtime:

| Action | Effect |
|---|---|
| `off` | Stop drawing and tear down what is on the page |
| `on` | Resume; pass `banner: false` to leave the pill and frame off |
| `clear` | Drop the current effects but stay installed |
| `status` | What is installed in the current tab |

Switch it off for unattended runs — it costs a script evaluation and about
`2 x KLOOT_OVERLAY_DELAY` per action:

```sh
KLOOT_OVERLAY=0 node bridge/server.js          # no visual feedback at all
KLOOT_OVERLAY_BANNER=0 node bridge/server.js   # effects, but no banner or frame
KLOOT_OVERLAY_DELAY=80 node bridge/server.js   # faster, effects may not render
```

The renderer is a single file, `extension/overlay.js`, injected from both halves:
the extension puts it in its isolated world, and the bridge evaluates the same
file into the page's main world for BiDi actions. Those two worlds have separate
`window` objects but share one DOM, so the overlay's state lives on its host
element and its open shadow root — whichever side runs first builds the nodes and
the other reuses them, rather than stacking a second cursor on top.

It cannot interfere with what it decorates. Everything is `pointer-events: none`,
so the trusted click still reaches the page, and everything lives in a shadow
root attached outside `<body>`, so `read_page`, `find` and `get_page_text` — none
of which cross a shadow boundary — never see it.

## Tests

Requires Firefox in debugging mode on `KLOOT_BIDI_PORT`.

```sh
cd bridge

# relay pairing and message routing, no browser needed.
# Run this against a bridge with no extension attached — its fake browser peer
# would otherwise evict the real extension, and the pairing checks would fail.
KLOOT_PORT=8801 KLOOT_BIDI=0 node server.js &
KLOOT_PORT=8801 node test-relay.js

# BiDi layer against real Firefox
KLOOT_BIDI_PORT=9333 node test-bidi.js

# full stack: installs the extension, drives real tools
KLOOT_PORT=8799 KLOOT_BIDI_PORT=9333 KLOOT_EXT_PATH=../extension node test-extension.js

# computer tool over BiDi, asserts isTrusted
KLOOT_PORT=8799 node test-computer.js

# visual overlay: what it draws, that it never eats the trusted click, and that
# it stays invisible to the page-reading tools
KLOOT_PORT=8799 node test-overlay.js
```

## Limitations

- Firefox permits **one** BiDi session at a time. The bridge holds it while
  running, so `install-extension.js` and the BiDi tests must run before the
  bridge starts, or they will be refused. Both the bridge and the installer
  release the session on exit, so stopping the bridge is enough — a Firefox
  restart is only needed if one of them is killed with `SIGKILL`.
- Extension tab ids and BiDi context ids are separate namespaces; they are joined
  by URL, which is ambiguous if two tabs show the same page.
- Only one browser peer at a time. A second connection replaces the first, so a
  stale socket cannot wedge the bridge — but two extensions cannot share it.
- No permission prompting. Claude Code's `allowed_domains` and permission-mode
  fields are accepted but not enforced — the bridge trusts its local caller.
- `gif_creator`, `file_upload`, `upload_image` and the shortcut tools are not
  implemented; they return a clear "not implemented" error.

## Provenance

The wire protocol was determined by inspecting the message shapes Claude Code and
the official Chrome extension exchange — interface facts, needed for
interoperability. No code from that extension is used here; every file in this
repository is an original implementation. The name and icons are deliberately
unrelated to Anthropic's marks.
