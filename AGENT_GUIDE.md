# Hermes Browser Bridge – AI Agent Guide

> **tl;dr** – This is a CSP-safe browser automation bridge. An AI (Hermes) on WSL/Windows can control any browser tab via a localhost relay and Tampermonkey userscript, even on strict sites like GitHub, ChatGPT, LinkedIn.

---

## What Is This

Hermes Browser Bridge is a **two-part proxy system**:

1.  **Relay** (`hermes-browser-relay.py`) – Runs on the same machine as the AI (WSL/Windows). Exposes HTTP APIs on `0.0.0.0:8765`.
2.  **Userscript** (`hermes-browser-bridge.user.js`) – Runs inside the browser via Tampermonkey. Polls the relay for commands over HTTP to bypass CSP/WebSocket blocks.

Because it uses **HTTP short-polling via `GM_xmlhttpRequest`**, it bypasses every CSP restriction that kills WebSocket bridges on production sites.

---

## What's New in v1.6.6

- **localhost tried FIRST** — the userscript now attempts `http://localhost:8765` before any RTC-discovered IPs. This fixes the most common WSL2 setup where Windows browsers reach WSL via loopback forwarding.
- **No stale WSL IP caching** — `172.x.x.x` WSL addresses change on reboot. They are no longer persisted to `localStorage`, preventing "No API reachable" after a reboot.
- **Dropped `location.hostname` candidate** — no more attempts like `http://www.google.com:8765`.
- **Iframe guard** — script refuses to run inside hidden iframes, preventing duplicate phantom clients.
- **Manual IP input** — when auto-discovery fails, a UI panel lets the user type the relay IP directly.

---

## Setup Steps

You need Python 3.9+ and `aiohttp`.

```bash
# Clone or cd to the project directory
git clone https://github.com/jlaiii/hermes-browser-bridge.git
cd hermes-browser-bridge

# Create venv (recommended)
python3 -m venv hermes-bridge-venv
source hermes-bridge-venv/bin/activate  # Windows: hermes-bridge-venv\Scripts\activate
pip install aiohttp

# Run relay
python3 hermes-browser-relay.py
```

The relay will print:
```
[Hermes Bridge] Running on http://0.0.0.0:8765
[Hermes Bridge]             http://172.23.87.155:8765   <-- this IP is what the browser needs
```

If you see a LAN IP **other than `127.0.0.1`**, the browser may be on a different network layer (WSL2/Windows host separation). Read [“WSL2 / Network Troubleshooting”](#wsl2--network-troubleshooting) below.

**Keep the relay running.** Use `tmux`, `screen`, or a background process manager if you step away.

### 2. Userscript (Browser Side)

1.  Install **Tampermonkey** for your browser:
    *   [Chrome/Edge](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
    *   [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
2.  Click the raw userscript URL to trigger install:
    *   https://github.com/jlaiii/hermes-browser-bridge/raw/main/hermes-browser-bridge.user.js
3.  Once installed, open any website. A small **“Hermes Bridge”** panel appears bottom-right.
4.  Wait 1–3 seconds. It turns **green** when connected.
5.  If it stays red, open the browser console (F12), paste:
    ```javascript
    localStorage.setItem('hermes_bridge_api', 'http://YOUR_WSL_IP:8765');
    location.reload();
    ```
    Replace `YOUR_WSL_IP` with the IP printed by the relay (e.g. `172.23.87.155`).

---

## Quick API Reference

Relay endpoints (all HTTP):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ping` | GET | Connectivity: `{"ok": true, "ts": ...}` |
| `/api/poll` | GET | Browser polls here for commands. Returns `{"type": "noop"}` or `{"type": "cmd", "data": {...}}`. |
| `/api/response` | POST | Browser posts command results here. |
| `/api/cmd` | POST | **Hermes sends commands here.** |
| `/api/clients` | GET | List all connected browser tabs. |

### Sending a Command (Python)

```python
import urllib.request, json

def cmd(action, **kwargs):
    d = {"action": action}
    d.update(kwargs)
    req = urllib.request.Request(
        'http://localhost:8765/api/cmd',
        data=json.dumps(d).encode(),
        headers={'Content-Type': 'application/json'}
    )
    resp = urllib.request.urlopen(req).read()
    return json.loads(resp)

# Test — get current page info
print(cmd("getInfo"))
# → {"ok": true, "data": {"url": "https://...", "title": "...", ...}}
```

### Sending a Command (curl)

```bash
curl -s -X POST http://localhost:8765/api/cmd \
  -H "Content-Type: application/json" \
  -d '{"action": "getInfo"}'
```

---

## Full Command List

| Action | Payload | What It Does |
|--------|---------|--------------|
| `ping` | `{}` | Health check |
| `getInfo` | `{}` | URL, title, viewport, scroll |
| `getHtml` | `{}` | Full page HTML |
| `getText` | `{}` | Visible text content |
| `navigate` | `{"url": "https://example.com"}` | Load a new URL |
| `eval` | `{"code": "document.title"}` | Run arbitrary JS |
| `click` | `{"selector": "#submit"}` | Click element by CSS selector |
| `clickByRef` | `{"ref": "@e3"}` | Click by bridge element ref |
| `type` | `{"selector": "#prompt", "text": "hello"}` | Type into `<input>`, `<textarea>`, or `contenteditable` |
| `press` | `{"selector": "body", "key": "Enter"}` | Simulate keypress |
| `scroll` | `{"direction": "down", "amount": 500}` | Scroll page |
| `scrollToElement` | `{"selector": "#footer"}` | Smooth scroll element into view |
| `querySelector` | `{"selector": ".btn"}` | Metadata for first match |
| `querySelectorAll` | `{"selector": "a"}` | Metadata for all matches |
| `getInteractiveElements` | `{}` | List of all clickable elements with `@e` refs |
| `focus` | `{"selector": "#search"}` | Focus element |
| `getValue` / `setValue` | `{"selector": "#qty", "value": "5"}` | Read/write form values |
| `waitForSelector` | `{"selector": ".loaded", "timeout": 10}` | Wait up to `timeout` seconds |
| `screenshotInfo` | `{}` | Viewport metadata for screenshots |

---

## Real-World Examples

### ChatGPT – Send a Message

```python
import urllib.request, json

def cmd(action, **kwargs):
    d = {"action": action, **kwargs}
    req = urllib.request.Request(
        'http://localhost:8765/api/cmd',
        data=json.dumps(d).encode(),
        headers={'Content-Type': 'application/json'}
    )
    return json.loads(urllib.request.urlopen(req).read())

# ChatGPT textarea is contenteditable div
result = cmd('type', selector='#prompt-textarea', text='Hello from Hermes Bridge!')
cmd('press', selector='#prompt-textarea', key='Enter')
```

### eBay – Extract Purchase History

```bash
# Navigate
curl -s -X POST http://localhost:8765/api/cmd \
  -H "Content-Type: application/json" \
  -d '{"action": "navigate", "url": "https://www.ebay.com/mye/myebay/purchase"}'

# Wait, then get text
curl -s -X POST http://localhost:8765/api/cmd \
  -H "Content-Type: application/json" \
  -d '{"action": "getText"}'
```

---

## WSL2 / Network Troubleshooting

**Issue:** Browser shows red “no API” and console has `XHR error`.

| Cause | Fix |
|-------|-----|
| WSL2 `localhost` forwarding broken | In browser console: `localStorage.setItem('hermes_bridge_api', 'http://172.23.87.155:8765'); location.reload();` |
| WSL2 IPv6 localhost mapped to `::1` | Already patched — script auto-falls back to `127.0.0.1` |
| Bridge running on different IP than browser expects | Check relay startup output for `http://<IP>:8765` and use that IP |
| Relay not running at all | `curl http://localhost:8765/api/ping` should return `{"ok": true}` |

### Permanent Fix for WSL2

If you always want `localhost:8765` from Windows to reach WSL:

1.  Create `C:\Users\%USERNAME%\.wslconfig`:
    ```ini
    [wsl2]
    localhostForwarding=true
    networkingMode=mirrored
    ```
2.  `wsl --shutdown`
3.  Restart WSL. Now `localhost:8765` works from Windows natively.

---

## Architecture

```
┌──────────────────┐   HTTP Polling (GM_xmlhttpRequest)    ┌──────────────────┐
│  Browser Tab 1   │◄───────────────────────────────────────►│  Relay Server    │
│  (userscript)    │   * GitHub, ChatGPT, LinkedIn, etc.   │  localhost:8765  │
│                  │                                       │                  │
│  Browser Tab 2   │                                       │  Hermes Agent    │
│  (userscript)    │   HTTP JSON API                       │  curl / Python   │
│                  │◄─────────────────────────────────────►│                  │
└──────────────────┘                                       └──────────────────┘
```

Tampermonkey has **elevated `GM_xmlhttpRequest`** privileges that bypass browser CSP. WebSockets cannot do this.

---

## File Structure

```
hermes-browser-bridge/
├── hermes-browser-bridge.user.js   ← Browser userscript (Tampermonkey)
├── hermes-browser-relay.py         ← Python relay (aiohttp)
├── install.sh                      ← Linux/Mac one-liner installer
├── install.bat                     ← Windows installer
├── docs/                           ← GitHub Pages site
│   ├── index.html
│   ├── install.html
│   └── about.html
├── README.md
└── AGENT_GUIDE.md                   ← This file
```

---

## Notes for AI Agents

- **Always check** `curl http://localhost:8765/api/ping` first to confirm the relay is alive.
- **Always check** `curl http://localhost:8765/api/clients` to see what tabs are connected before sending commands.
- If a command times out, the tab may have refreshed or closed — check the clients list again.
- The `type` action handles both real `<input>` elements and `contenteditable` divs (ChatGPT, etc.) automatically.
- The `navigate` action changes the page URL. The userscript on the **new page** will auto-re-register with a new client ID after a few seconds. Wait briefly before sending the next command.
- For sites with heavy anti-automation (reCAPTCHA, Cloudflare), use `eval` to read DOM state but avoid rapid-fire clicking.

---

*Project URL:* https://github.com/jlaiii/hermes-browser-bridge  
*Live Site:* https://jlaiii.github.io/hermes-browser-bridge/
