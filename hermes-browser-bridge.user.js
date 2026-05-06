// ==UserScript==
// @name         Hermes Browser Bridge (CSP-safe)
// @namespace    http://hermes-agent.local/
// @version      1.4
// @description  Remote control bridge for Hermes Agent — uses HTTP short-polling to bypass CSP on strict sites.
// @author       Hermes Agent
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const API_CANDIDATES = ['http://localhost:8765', 'http://127.0.0.1:8765'];
    const BOOT_TIMEOUT_MS = 4000;
    const POLL_TIMEOUT_MS = 30000;
    const RECONNECT_MS = 2000;

    let API_BASE = null;
    let clientId = null;
    let isPolling = false;
    let logLines = [];
    let panel = null;
    let interactiveMap = new Map();

    const gmXHR = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
                 || (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlHttpRequest)
                 || null;

    function dbg(msg) {
        const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        logLines.push(line);
        if (logLines.length > 50) logLines.shift();
        if (panel) {
            const pre = panel.querySelector('pre');
            if (pre) pre.textContent = logLines.join('\n');
        }
        console.log('[HermesBridge]', msg);
    }

    function createPanel() {
        if (document.getElementById('hermes-bridge-panel')) return;
        const d = document.createElement('div');
        d.id = 'hermes-bridge-panel';
        d.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483647;width:380px;max-height:260px;background:#111;border:1px solid #333;border-radius:6px;color:#eee;font-family:monospace;font-size:11px;overflow:hidden;display:flex;flex-direction:column;';
        d.innerHTML = `
            <div style="padding:4px 8px;background:#222;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;">
                <span>Hermes Bridge</span>
                <span id="hb-status" style="color:#888;">init...</span>
            </div>
            <pre style="margin:0;padding:4px 8px;overflow-y:auto;flex:1;white-space:pre-wrap;word-break:break-word;font-size:10px;color:#aaa;"></pre>
        `;
        document.body.appendChild(d);
        panel = d;
        d.querySelector('div').addEventListener('click', () => {
            const pre = d.querySelector('pre');
            pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
        });
    }

    function setStatus(txt, color) {
        const s = document.getElementById('hb-status');
        if (s) { s.textContent = txt; s.style.color = color || '#888'; }
    }

    function xhr(method, url, data, timeoutMs, onload, onerror) {
        if (!gmXHR) {
            dbg('GM_xmlhttpRequest not available!');
            if (onerror) onerror({error:'GM_xmlhttpRequest unavailable'});
            return;
        }
        const opts = {
            method: method,
            url: url,
            headers: data ? {"Content-Type": "application/json"} : {},
            data: data ? JSON.stringify(data) : null,
            timeout: timeoutMs || BOOT_TIMEOUT_MS,
            onload: function(resp) {
                if (onload) onload(resp);
            },
            onerror: function(resp) {
                const info = resp ? (resp.statusText || resp.error || resp.status || 'unknown') : 'unknown';
                dbg('XHR error: ' + info);
                if (onerror) onerror(resp);
            },
            ontimeout: function(resp) {
                dbg('XHR timeout');
                if (onerror) onerror(resp);
            }
        };
        gmXHR(opts);
    }

    // --- Discover working API base ---
    function discoverAPI(callback) {
        let tried = 0;
        const total = API_CANDIDATES.length;
        function tryNext() {
            if (tried >= total) {
                dbg('No API reachable (tried ' + API_CANDIDATES.join(', ') + ')');
                callback(null);
                return;
            }
            const base = API_CANDIDATES[tried++];
            dbg('Trying API: ' + base + '...');
            xhr('GET', base + '/api/ping', null, BOOT_TIMEOUT_MS, function(resp) {
                try {
                    const d = JSON.parse(resp.responseText);
                    if (d.ok) {
                        dbg('API OK: ' + base);
                        API_BASE = base;
                        callback(base);
                        return;
                    }
                } catch(e) {}
                tryNext();
            }, function() {
                tryNext();
            });
        }
        tryNext();
    }

    // --- Polling loop ---
    function startPolling() {
        if (isPolling) return;
        isPolling = true;
        doPoll();
    }

    function doPoll() {
        if (!isPolling || !API_BASE) return;
        const url = API_BASE + '/api/poll?client_id=' + encodeURIComponent(clientId || '') + '&url=' + encodeURIComponent(location.href);
        xhr('GET', url, null, POLL_TIMEOUT_MS, function(resp) {
            try {
                const msg = JSON.parse(resp.responseText);
                if (msg.type === 'cmd' && msg.data) {
                    dbg('RCV: ' + msg.data.action);
                    handleCommand(msg.data);
                }
                if (msg.client_id && !clientId) {
                    clientId = msg.client_id;
                    dbg('Registered as client ' + clientId.slice(-6));
                    setStatus('connected', '#0f0');
                }
            } catch(e) {
                dbg('Bad poll response');
            }
            setTimeout(doPoll, 100);
        }, function() {
            setStatus('disconnected', '#f44');
            // API might have changed (VPN, sleep/wake) — rediscover after a few failures
            setTimeout(function() {
                isPolling = false;
                discoverAPI(function(base) {
                    if (base) startPolling();
                    else setTimeout(boot, RECONNECT_MS);
                });
            }, RECONNECT_MS);
        });
    }

    function sendResult(obj) {
        if (!API_BASE) return;
        const url = API_BASE + '/api/response?client_id=' + encodeURIComponent(clientId || '');
        xhr('POST', url, obj, BOOT_TIMEOUT_MS, function() {
            dbg('SND: ' + obj.type);
        }, function() {
            dbg('Send failed');
        });
    }

    // --- Element map ---
    function buildInteractiveMap() {
        interactiveMap.clear();
        const sel = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], summary, label';
        const els = Array.from(document.querySelectorAll(sel));
        let idx = 1;
        els.forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            interactiveMap.set('@e' + idx++, el);
        });
        return interactiveMap;
    }

    function summarizeElement(el) {
        const r = el.getBoundingClientRect();
        const txt = (el.innerText || el.textContent || el.value || el.placeholder || el.title || el.getAttribute('aria-label') || '').trim();
        return {
            tag: el.tagName,
            type: el.type || null,
            text: txt.slice(0, 300),
            href: el.href || null,
            selector: getUniqueSelector(el),
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
            rect: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}
        };
    }

    function getUniqueSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        const tag = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
            const c = el.className.split(/\s+/).filter(Boolean).slice(0,2).join('.');
            if (c) return tag + '.' + c;
        }
        const parent = el.parentElement;
        if (parent) {
            const sibs = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (sibs.length > 1) {
                const i = sibs.indexOf(el) + 1;
                return tag + ':nth-of-type(' + i + ')';
            }
        }
        return tag;
    }

    // --- Commands ---
    function handleCommand(cmd) {
        const id = cmd.id || 0;
        try {
            switch (cmd.action) {
                case 'ping':
                    sendResult({type: 'pong', id});
                    break;
                case 'getInfo':
                    sendResult({type: 'result', id, data: {
                        url: location.href, title: document.title,
                        width: window.innerWidth, height: window.innerHeight,
                        scrollX: window.scrollX, scrollY: window.scrollY
                    }}); break;
                case 'getHtml':
                    sendResult({type: 'result', id, data: document.documentElement.outerHTML}); break;
                case 'getText':
                    sendResult({type: 'result', id, data: document.body.innerText}); break;
                case 'querySelector': {
                    const q = document.querySelector(cmd.selector);
                    sendResult({type: 'result', id, data: q ? summarizeElement(q) : null}); break; }
                case 'querySelectorAll': {
                    const qa = Array.from(document.querySelectorAll(cmd.selector));
                    sendResult({type: 'result', id, data: qa.map(e => summarizeElement(e))}); break; }
                case 'getInteractiveElements': {
                    buildInteractiveMap();
                    const out = [];
                    interactiveMap.forEach((el, ref) => { const s=summarizeElement(el); s.ref=ref; out.push(s); });
                    sendResult({type: 'result', id, data: out}); break; }
                case 'click': {
                    const c = document.querySelector(cmd.selector);
                    if (c) { c.scrollIntoView({block:'center'}); setTimeout(()=>{c.click();sendResult({type:'result',id,data:'clicked'});},200); }
                    else sendResult({type:'error',id,message:'element not found'}); break; }
                case 'clickByRef': {
                    let cr = interactiveMap.get(cmd.ref);
                    if (!cr) { buildInteractiveMap(); cr = interactiveMap.get(cmd.ref); }
                    if (cr) { cr.scrollIntoView({block:'center'}); setTimeout(()=>{cr.click();sendResult({type:'result',id,data:'clicked '+cmd.ref});},200); }
                    else sendResult({type:'error',id,message:'ref not found: '+cmd.ref}); break; }
                case 'type': {
                    const t = document.querySelector(cmd.selector);
                    if (!t) { sendResult({type:'error',id,message:'element not found'}); break; }
                    t.focus();
                    if (t.contentEditable === 'true') {
                        if (cmd.clear!==false) t.innerText='';
                        t.innerText=(cmd.text||'');
                        t.dispatchEvent(new InputEvent('input',{bubbles:true,data:(cmd.text||''),inputType:'insertText'}));
                    } else {
                        if (cmd.clear!==false) t.value='';
                        t.value=(cmd.text||'');
                        ['input','change','keyup','keydown'].forEach(ev=> t.dispatchEvent(new Event(ev,{bubbles:true})));
                    }
                    sendResult({type:'result',id,data:'typed'}); break; }
                case 'press': {
                    const target = document.querySelector(cmd.selector) || document.activeElement || document.body;
                    const k = (cmd.key||'Enter').toLowerCase();
                    const map = {enter:{key:'Enter',code:'Enter',keyCode:13,which:13},tab:{key:'Tab',code:'Tab',keyCode:9,which:9},escape:{key:'Escape',code:'Escape',keyCode:27,which:27},esc:{key:'Escape',code:'Escape',keyCode:27,which:27},arrowdown:{key:'ArrowDown',code:'ArrowDown',keyCode:40,which:40},arrowup:{key:'ArrowUp',code:'ArrowUp',keyCode:38,which:38},arrowleft:{key:'ArrowLeft',code:'ArrowLeft',keyCode:37,which:37},arrowright:{key:'ArrowRight',code:'ArrowRight',keyCode:39,which:39},space:{key:' ',code:'Space',keyCode:32,which:32}};
                    const d = map[k] || {key:cmd.key,code:cmd.key,keyCode:0,which:0};
                    ['keydown','keypress','keyup'].forEach(typ=> target.dispatchEvent(new KeyboardEvent(typ,{bubbles:true,cancelable:true,key:d.key,code:d.code,keyCode:d.keyCode,which:d.which})));
                    sendResult({type:'result',id,data:'pressed '+cmd.key}); break; }
                case 'scroll': {
                    const dir = cmd.direction || 'down'; const amt = cmd.amount || 500;
                    if (dir==='down') window.scrollBy(0,amt); else if (dir==='up') window.scrollBy(0,-amt);
                    else if (dir==='top') window.scrollTo(0,0); else if (dir==='bottom') window.scrollTo(0,document.body.scrollHeight);
                    else if (dir==='left') window.scrollBy(-amt,0); else if (dir==='right') window.scrollBy(amt,0);
                    sendResult({type:'result',id,data:'scrolled '+dir}); break; }
                case 'scrollToElement': {
                    const st = document.querySelector(cmd.selector);
                    if (st) { st.scrollIntoView({block:'center',behavior:'smooth'}); sendResult({type:'result',id,data:'scrolled'}); }
                    else sendResult({type:'error',id,message:'element not found'}); break; }
                case 'navigate':
                    location.href = cmd.url; break;
                case 'eval': {
                    let res; try { res = eval(cmd.code); } catch(e) { sendResult({type:'error',id,message:e.message}); break; }
                    let payload; try { payload = JSON.parse(JSON.stringify(res)); } catch(e) { payload = String(res); }
                    sendResult({type:'result',id,data:payload}); break; }
                case 'waitForSelector': {
                    const wsSel = cmd.selector; const wsMs = (cmd.timeout||5)*1000; const wsStart = Date.now();
                    const wsPoll = () => { const wEl=document.querySelector(wsSel); if(wEl)sendResult({type:'result',id,data:{found:true,selector:wsSel}}); else if(Date.now()-wsStart<wsMs)setTimeout(wsPoll,250); else sendResult({type:'result',id,data:{found:false,selector:wsSel,timeout:true}}); };
                    wsPoll(); break; }
                case 'focus': {
                    const f = document.querySelector(cmd.selector);
                    if (f) { f.focus(); sendResult({type:'result',id,data:'focused'}); }
                    else sendResult({type:'error',id,message:'element not found'}); break; }
                case 'getValue': {
                    const gv = document.querySelector(cmd.selector);
                    if (gv) sendResult({type:'result',id,data:gv.value}); else sendResult({type:'error',id,message:'element not found'}); break; }
                case 'setValue': {
                    const sv = document.querySelector(cmd.selector);
                    if (sv) { sv.value = cmd.value; ['input','change'].forEach(e=> sv.dispatchEvent(new Event(e,{bubbles:true}))); sendResult({type:'result',id,data:'value set'}); }
                    else sendResult({type:'error',id,message:'element not found'}); break; }
                case 'screenshotInfo': {
                    sendResult({type:'result',id,data:{width:window.innerWidth,height:window.innerHeight,scrollX:window.scrollX,scrollY:window.scrollY,url:location.href,devicePixelRatio:window.devicePixelRatio}}); break; }
                default:
                    sendResult({type:'error',id,message:'unknown action: '+cmd.action});
            }
        } catch(err) {
            sendResult({type:'error',id,message:err.message});
        }
    }

    // --- Boot ---
    function boot() {
        if (!document.body) { setTimeout(boot, 100); return; }
        createPanel();
        dbg('CSP-safe bridge loaded on ' + location.href);
        setStatus('discovering...', '#fa0');

        discoverAPI(function(base) {
            if (!base) {
                setStatus('no API', '#f44');
                dbg('Will retry in ' + RECONNECT_MS + 'ms');
                setTimeout(boot, RECONNECT_MS);
                return;
            }
            // Register and start polling
            const url = API_BASE + '/api/poll?url=' + encodeURIComponent(location.href);
            xhr('GET', url, null, BOOT_TIMEOUT_MS, function(resp) {
                try {
                    const d = JSON.parse(resp.responseText);
                    if (d.client_id) {
                        clientId = d.client_id;
                        dbg('Registered as client ' + clientId.slice(-6));
                        setStatus('connected', '#0f0');
                    } else {
                        setStatus('polling', '#ff0');
                    }
                } catch(e) {
                    dbg('Poll response parse error');
                }
                startPolling();
            }, function() {
                setStatus('disconnected', '#f44');
                setTimeout(boot, RECONNECT_MS);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
