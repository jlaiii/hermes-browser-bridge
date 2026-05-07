#!/usr/bin/env python3
"""
Hermes Browser Bridge Relay - HTTP Short-Polling version
Robust across all sites including GitHub, LinkedIn, ChatGPT, etc.

Usage:
  cd /mnt/c/Users/jayst/Desktop
  ./hermes-bridge-venv/bin/python3 hermes-browser-relay.py
"""

import asyncio, json, time, random, socket, subprocess
from aiohttp import web

PORT = 8765

def get_lan_ips():
    """Get all non-loopback local IPv4 addresses (WSL-safe)."""
    ips = []
    # Method 1: ip addr (works on WSL/Linux)
    try:
        out = subprocess.check_output(['ip', 'addr'], text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines():
            if 'inet ' in line and not '127.0.0.1' in line:
                parts = line.strip().split()
                if len(parts) >= 2:
                    ip = parts[1].split('/')[0]
                    if not ip.startswith('127.'):
                        ips.append(ip)
    except Exception:
        pass
    # Method 2: socket fallback
    if not ips:
        try:
            hostname = socket.gethostname()
            for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
                ip = info[4][0]
                if not ip.startswith('127.'):
                    ips.append(ip)
        except Exception:
            pass
    return list(dict.fromkeys(ips))  # dedup

clients = {}  # client_id -> {"queue": [cmds], "last_seen": timestamp, "url": str}
results = {}  # cmd_id -> response dict


def new_client_id():
    return str(int(time.time() * 100000)) + str(random.randint(0, 9999))


async def http_poll(request):
    """Browser polls here every ~1.5s. Return command immediately if one exists."""
    cid = request.query.get("client_id")
    if not cid or cid not in clients:
        cid = new_client_id()
        clients[cid] = {"queue": [], "last_seen": time.time(), "url": None}

    clients[cid]["last_seen"] = time.time()
    url = request.query.get("url")
    if url:
        clients[cid]["url"] = url

    if clients[cid]["queue"]:
        cmd = clients[cid]["queue"].pop(0)
        return web.json_response({"type": "cmd", "client_id": cid, "data": cmd})

    return web.json_response({"type": "noop", "client_id": cid})


async def http_ping(request):
    """Simple connectivity test."""
    return web.json_response({"ok": True, "ts": time.time()})


async def http_response(request):
    """Browser posts command results here."""
    try:
        data = await request.json()
    except:
        return web.json_response({"error": "bad json"}, status=400)

    if "id" in data:
        results[data["id"]] = data
    return web.json_response({"ok": True})


async def http_cmd(request):
    """Hermes posts a command here; we queue it for the browser."""
    try:
        cmd = await request.json()
    except:
        return web.json_response({"error": "bad json"}, status=400)

    cmd_id = str(int(time.time() * 100000)) + str(random.randint(0, 9999))
    cmd["id"] = cmd_id

    target = cmd.pop("client_id", None)
    sent = False
    for cid, meta in list(clients.items()):
        if target is None or str(cid) == str(target):
            meta["queue"].append(cmd)
            sent = True

    if not sent:
        return web.json_response({"error": "no browser connected"}, status=503)

    # Wait up to 12s for response
    for _ in range(120):
        if cmd_id in results:
            r = results.pop(cmd_id)
            return web.json_response(r)
        await asyncio.sleep(0.1)
    return web.json_response({"error": "timeout", "id": cmd_id}, status=504)


async def http_clients(request):
    out = [{"id": k, "url": v["url"]} for k, v in clients.items()]
    return web.json_response({"clients": out})


async def cleanup_task():
    while True:
        await asyncio.sleep(30)
        now = time.time()
        stale = [k for k, v in clients.items() if now - v["last_seen"] > 60]
        for k in stale:
            del clients[k]


async def on_startup(app):
    asyncio.create_task(cleanup_task())
    ips = get_lan_ips()
    print(f"\n[Hermes Bridge] Running on http://0.0.0.0:{PORT}")
    for ip in ips:
        print(f"[Hermes Bridge]             http://{ip}:{PORT}")
    print(f"[Hermes Bridge] Browser poll:   GET  http://localhost:{PORT}/api/poll")
    print(f"[Hermes Bridge] Browser result: POST http://localhost:{PORT}/api/response")
    print(f"[Hermes Bridge] Hermes command: POST http://localhost:{PORT}/api/cmd")
    print(f"[Hermes Bridge] Clients list:   GET  http://localhost:{PORT}/api/clients\n")


app = web.Application()
app.router.add_get("/api/ping", http_ping)
app.router.add_get("/api/poll", http_poll)
app.router.add_post("/api/response", http_response)
app.router.add_post("/api/cmd", http_cmd)
app.router.add_get("/api/clients", http_clients)
app.on_startup.append(on_startup)

if __name__ == "__main__":
    try:
        import aiohttp
    except ImportError:
        print("[Hermes Bridge] ERROR: aiohttp not installed.")
        print("[Hermes Bridge] Run:  pip3 install aiohttp")
        exit(1)
    web.run_app(app, host="0.0.0.0", port=PORT, print=False)
