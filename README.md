# Hermes Browser Bridge

> CSP-safe remote control for any browser tab. Automate clicks, typing, navigation, and data extraction on sites that block WebSockets — GitHub, ChatGPT, LinkedIn, and more.

**[🌐 Live Site](https://jlaiii.github.io/hermes-browser-bridge/)**

---

## Who It's For

- **AI agents & automation scripts** — control browsers from Python scripts or terminal tools
- **Web developers** — test, scrape, or automate tasks on strict CSP sites
- **Power users** — fill forms, navigate pages, and extract data remotely
- **Anyone who needs browser automation** when WebSockets and extensions are blocked

---

## What It Does

- **Sends commands to live browser tabs** — click, type, scroll, navigate, extract text/HTML, evaluate JS, etc.
- **Bypasses CSP (Content Security Policy)** — works on GitHub, LinkedIn, ChatGPT, Twitter/X, and other strict sites that block normal WebSocket connections.
- **Auto-reconnects** — survives tab refreshes, network hiccups, and browser restarts.
- **Zero config for browsers** — just install the Tampermonkey userscript and it auto-discovers the relay on `localhost` or `127.0.0.1`.
- **Multiple tabs at once** — every tab becomes an independently controllable client.

---

## Architecture

```
┌─────────────────┐       HTTP Polling (GM.xmlHttpRequest)
│  Browser Tabs   │◄───────────────────────────────────────
│  (userscript)   │
└────────┬────────┘
         │ GET  /api/ping
         │ POST /api/response
         │ GET  /api/poll
         ▼
┌─────────────────┐       HTTP JSON API
│  Relay Server   │◄───────────────────────────────────────
│  localhost:8765 │
└────────┬────────┘
         │ POST /api/cmd
         ▼
┌─────────────────┐
│  Hermes Agent   │
│  or any script  │
└─────────────────┘
```

Because it uses **HTTP short-polling via Tampermonkey's privileged `GM.xmlHttpRequest`**, it completely bypasses browser CSP restrictions that kill WebSocket connections on sites like GitHub.com.

---

## Quick Start

### 1. Install the Relay Server

**Option A: One-liner (Linux/Mac)**
```bash
curl -fsSL https://jlaiii.github.io/hermes-browser-bridge/install.sh | bash
```

**Option B: Manual**
```bash
git clone https://github.com/jlaiii/hermes-browser-bridge.git
cd hermes-browser-bridge
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install aiohttp
python3 hermes-browser-relay.py
```

**Option C: Windows Batch**
Download and run `install.bat` from the releases page.

### 2. Install the Browser Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) for Firefox/Chrome/Edge.
2. Click [Install Script](https://github.com/jlaiii/hermes-browser-bridge/raw/main/hermes-browser-bridge.user.js) or copy `hermes-browser-bridge.user.js` into a new Tampermonkey script.
3. Open any website. A small **"Hermes Bridge"** panel appears in the bottom-right.
4. Wait 1–3 seconds. Panel turns **green = connected**.

### 3. Control It

```bash
# List active browser tabs
curl http://localhost:8765/api/clients

# Send a command to the latest tab
curl -X POST http://localhost:8765/api/cmd \
  -H "Content-Type: application/json" \
  -d '{"action": "getInfo"}'
```

---

## Commands

| Action | Description | Example Payload |
|--------|-------------|-----------------|
| `ping` | Verify bridge is alive | `{}` |
| `getInfo` | Current URL, title, viewport | `{}` |
| `getHtml` | Full page HTML | `{}` |
| `getText` | Visible text content | `{}` |
| `navigate` | Go to URL | `{"url": "https://..."}` |
| `eval` | Run JavaScript in page | `{"code": "document.title"}` |
| `click` | Click element by CSS selector | `{"selector": "#submit"}` |
| `clickByRef` | Click by bridge element ref | `{"ref": "@e3"}` |
| `type` | Type into input/textarea/contenteditable | `{"selector": "#prompt", "text": "hello"}` |
| `press` | Simulate keypress | `{"selector": "body", "key": "Enter"}` |
| `scroll` | Scroll the page | `{"direction": "down", "amount": 500}` |
| `scrollToElement` | Scroll element into view | `{"selector": "#footer"}` |
| `querySelector` | Get element metadata | `{"selector": ".btn"}` |
| `querySelectorAll` | Get all matching elements | `{"selector": "a"}` |
| `getInteractiveElements` | Map clickable elements to refs | `{}` |
| `focus` | Focus an element | `{"selector": "#search"}` |
| `getValue` / `setValue` | Read/write form values | `{"selector": "#qty", "value": "5"}` |
| `waitForSelector` | Wait for element to appear | `{"selector": ".loaded", "timeout": 10}` |
| `screenshotInfo` | Get viewport metadata for screenshots | `{}` |

---

## Real-World Examples

### Send a message on ChatGPT
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
    return json.loads(urllib.request.urlopen(req).read())

# Find ChatGPT client
cmd('type', selector='#prompt-textarea', text='Hello from the bridge!')
cmd('press', selector='#prompt-textarea', key='Enter')
```

### Extract eBay purchase history
```python
# Navigate to purchase history
cmd('navigate', url='https://www.ebay.com/mye/myebay/purchase')
# Wait for load, then read text
text = cmd('getText')['data']
```

### Click specific link by element ref
```python
# Map all interactive elements
els = cmd('getInteractiveElements')['data']
# Click the 3rd element found
if len(els) >= 3:
    cmd('clickByRef', ref=els[2]['ref'])
```

---

## File Structure

```
hermes-browser-bridge/
├── hermes-browser-bridge.user.js   ← Tampermonkey userscript (browser side)
├── hermes-browser-relay.py         ← aiohttp relay server (local machine)
├── install.sh                      ← Linux/Mac installer
├── install.bat                     ← Windows installer
├── site/                           ← GitHub Pages website
│   ├── index.html
│   └── install.html
└── README.md
```

---

## Development

```bash
git clone https://github.com/jlaiii/hermes-browser-bridge.git
cd hermes-browser-bridge
python3 -m venv venv
source venv/bin/activate
pip install aiohttp
python3 hermes-browser-relay.py
```

---

## License

MIT — see [LICENSE](LICENSE)
