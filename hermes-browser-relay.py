#!/usr/bin/env python3
"""
Hermes Browser Bridge Relay v2.0.1
HTTP short-polling with proper command/response lifecycle.

Changelog:
  v2.0.1 — reduced NEW_CLIENT_THROTTLE_SEC from 5s to 3s
  v2.0.0 — added stale client_id cleanup, found_existing flag, IP-based reuse on reload
  v1.x   — initial relay

"""

Usage:
  cd /mnt/c/Users/jayst/Desktop
  ./hermes-bridge-venv/bin/python3 hermes-browser-relay.py
"""

import asyncio, json, time, random, socket, subprocess
from aiohttp import web

PORT = 8765
NEW_CLIENT_THROTTLE_SEC = 5  # Don't create new client from blank ID faster than every 5s per IP

clients = {}       # client_id -> {"queue": [], "last_seen": ts, "url": str, "ip": str, "connected": bool}
results = {}       # cmd_id -> response dict
blank_cid_ips = {} # ip -> timestamp of last new-client creation


def get_lan_ips():
    ips = []
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
    if not ips:
        try:
            hostname = socket.gethostname()
            for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
                ip = info[4][0]
                if not ip.startswith('127.'):
                    ips.append(ip)
        except Exception:
            pass
    return list(dict.fromkeys(ips))


def new_client_id():
    return str(int(time.time() * 1000000)) + str(random.randint(0, 9999))


async def http_ping(request):
    """Simple connectivity test."""
    return web.json_response({"ok": True, "ts": time.time()})


async def http_poll(request):
    """Browser polls here. Creates client if new, returns queued commands."""
    cid = request.query.get("client_id", "").strip()
    bye = request.query.get("bye", "")
    url = request.query.get("url", "")
    ip = request.remote or ""

    if bye and cid:
        if cid in clients:
            del clients[cid]
        return web.json_response({"type": "bye", "client_id": cid})

    found_existing = cid and cid in clients
    if not cid:
        # blank client_id: try to reuse existing client from same IP
        for c in reversed(list(clients.keys())):
            if clients[c].get("ip") == ip:
                cid = c
                found_existing = True
                break

    if not found_existing:
        if cid and cid not in clients:
            # stale client_id from page reload — attempt IP-based reuse
            for c in reversed(list(clients.keys())):
                if clients[c].get("ip") == ip:
                    cid = c
                    found_existing = True
                    break
    
    if not found_existing:
        # create new client (throttled)
        now = time.time()
        last_blank = blank_cid_ips.get(ip, 0)
        if now - last_blank < NEW_CLIENT_THROTTLE_SEC:
            return web.json_response({"type": "noop", "client_id": "", "message": "throttled"})
        cid = new_client_id()
        blank_cid_ips[ip] = now
        clients[cid] = {"queue": [], "last_seen": now, "url": None, "ip": ip, "connected": True}
    else:
        clients[cid]["connected"] = True

    clients[cid]["last_seen"] = time.time()
    if url:
        clients[cid]["url"] = url

    if clients[cid]["queue"]:
        cmd = clients[cid]["queue"].pop(0)
        return web.json_response({"type": "cmd", "client_id": cid, "data": cmd})

    return web.json_response({"type": "noop", "client_id": cid})


async def http_response(request):
    """Browser posts command results here."""
    try:
        data = await request.json()
    except:
        return web.json_response({"error": "bad json"}, status=400)

    if "id" in data:
        results[data["id"]] = data
    return web.json_response({"ok": True})


async def http_send(request):
    """
    Unified endpoint: POST a command and wait for the response.
    Body: {"client_id": "optional", "action": "...", ...params}
    Waits up to 15s for the browser to execute and respond.
    """
    try:
        cmd = await request.json()
    except:
        return web.json_response({"error": "bad json"}, status=400)

    cmd_id = str(int(time.time() * 1000000)) + str(random.randint(0, 9999))
    cmd["id"] = cmd_id

    target = cmd.pop("client_id", None)
    sent = False
    for cid, meta in list(clients.items()):
        if target is None or str(cid) == str(target):
            meta["queue"].append(cmd)
            sent = True

    if not sent:
        return web.json_response({"error": "no browser connected", "code": "NO_CLIENTS"}, status=503)

    # Wait up to 15s for response
    for _ in range(150):
        if cmd_id in results:
            r = results.pop(cmd_id)
            return web.json_response(r)
        await asyncio.sleep(0.1)
    return web.json_response({"error": "timeout", "id": cmd_id, "code": "TIMEOUT"}, status=504)


async def http_cmd(request):
    """Legacy Hermes command endpoint (queues command, legacy wait)."""
    try:
        cmd = await request.json()
    except:
        return web.json_response({"error": "bad json"}, status=400)

    cmd_id = str(int(time.time() * 1000000)) + str(random.randint(0, 9999))
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
    """List all connected clients with metadata."""
    now = time.time()
    out = []
    for k, v in clients.items():
        out.append({
            "id": k,
            "url": v["url"],
            "last_seen": round(now - v["last_seen"], 1),
            "ip": v.get("ip", ""),
            "connected": v.get("connected", False),
            "queue": len(v["queue"])
        })
    return web.json_response({
        "clients": out,
        "count": len(out),
        "timestamp": time.time()
    })


async def http_status(request):
    """Quick relay status."""
    return web.json_response({
        "ok": True,
        "uptime": time.time(),
        "clients": len(clients),
        "timestamp": time.time()
    })


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
    print(f"[Hermes Bridge] Send command:  POST http://localhost:{PORT}/api/send")
    print(f"[Hermes Bridge] Legacy cmd:    POST http://localhost:{PORT}/api/cmd")
    print(f"[Hermes Bridge] Clients list:   GET  http://localhost:{PORT}/api/clients")
    print(f"[Hermes Bridge] Status:         GET  http://localhost:{PORT}/api/status\n")


app = web.Application()
app.router.add_get("/api/ping", http_ping)
app.router.add_get("/api/status", http_status)
app.router.add_get("/api/poll", http_poll)
app.router.add_post("/api/response", http_response)
app.router.add_post("/api/send", http_send)
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
