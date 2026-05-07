// ==UserScript==
// @name         Hermes Browser Bridge (CSP-safe)
// @namespace    http://hermes-agent.local/
// @version      1.6.6
// @description  CSP-safe remote control for any browser tab. HTTP short-polling bridge that bypasses CSP. v1.6.6: prefers localhost first, avoids stale WSL IP caching, drops location.hostname candidate.
// @author       Hermes Agent
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Prevent bridge from running inside iframes/hidden frames
    if (window.self !== window.top) {
        return;
    }

    // --- User overrides ---
    const USER_API = (typeof window !== 'undefined' && window.__HERMES_BRIDGE_API__)
        || (typeof localStorage !== 'undefined' && localStorage.getItem('hermes_bridge_api'))
        || null;

    // --- Config ---
    const BOOT_TIMEOUT_MS = 2500;
    const POLL_TIMEOUT_MS = 30000;
    const RECONNECT_MS = 3000;
    const MAX_CONSECUTIVE_ERRORS = 5;
    const TAB_ID = 'hermes_tab_' + (location.origin || 'default').replace(/[^a-z0-9]/gi, '_');

    let API_BASE = null;
    let clientId = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('hermes_client_id_' + TAB_ID)) || null;
    let isPolling = false;
    let logLines = [];
    let panel = null;
    let interactiveMap = new Map();
    let isUnloading = false;
    let consecutiveErrors = 0;
    let metaRefreshSec = 0;
    let bootTimer = null;

    const gmXHR = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
                 || (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlHttpRequest)
                 || null;

    function detectMetaRefresh() {
        const meta = document.querySelector('meta[http-equiv="refresh"]');
        if (meta) {
            const content = meta.getAttribute('content') || '';
            const m = content.match(/^\d+/);
            if (m) metaRefreshSec = parseInt(m[0], 10);
        }
    }

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
        d.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483647;width:420px;max-height:300px;background:#111;border:1px solid #333;border-radius:6px;color:#eee;font-family:monospace;font-size:11px;overflow:hidden;display:flex;flex-direction:column;';
        d.innerHTML = `
            <div style="padding:4px 8px;background:#222;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;">
                <span>Hermes Bridge</span>
                <span id="hb-status" style="color:#888;">init...</span>
            </div>
            <pre style="margin:0;padding:4px 8px;overflow-y:auto;flex:1;white-space:pre-wrap;word-break:break-word;font-size:10px;color:#aaa;"></pre>
        `;
        if (document.body) document.body.appendChild(d);
        else {
            // body not ready yet
            document.addEventListener('DOMContentLoaded', function(){ if (!document.getElementById('hermes-bridge-panel')) document.body.appendChild(d); });
        }
        panel = d;
        d.querySelector('div').addEventListener('click', () => {
            const pre = d.querySelector('pre');
            pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
        });
    }

    function showManualInput(attempted) {
        if (!panel) createPanel();
        const existing = document.getElementById('hb-manual-input');
        if (existing) return;
        const div = document.createElement('div');
        div.id = 'hb-manual-input';
        div.style.cssText = 'padding:6px 8px;border-top:1px solid #333;';
        div.innerHTML = `
            <div style="color:#f44;margin-bottom:4px;">Cannot find relay. Tried: ${attempted.slice(0,3).join(', ')}${attempted.length>3?'...':''}</div>
            <div style="display:flex;gap:4px;">
                <input id="hb-ip" placeholder="http://IP:8765" style="flex:1;padding:4px;border-radius:3px;border:1px solid #555;background:#222;color:#0f0;font-family:monospace;">
                <button id="hb-set" style="padding:4px 8px;background:#0a0;color:#fff;border:none;border-radius:3px;cursor:pointer;">Connect</button>
            </div>
        `;
        panel.appendChild(div);
        document.getElementById('hb-set').addEventListener('click', () => {
            const val = (document.getElementById('hb-ip').value || '').trim();
            if (!val) return;
            localStorage.setItem('hermes_bridge_api', val);
            dbg('Manual API set: ' + val + '\nRefresh this page...');
            div.remove();
        });
    }

    function setStatus(txt, color) {
        const s = document.getElementById('hb-status');
        if (s) { s.textContent = txt; s.style.color = color || '#888'; }
    }

    function formatErrorInfo(resp) {
        if (!resp) return '(no resp)';
        const parts = [];
        if (resp.status && resp.status !== 0) parts.push('status=' + resp.status);
        if (resp.statusText && resp.statusText !== '') parts.push('text=' + resp.statusText);
        if (resp.error) parts.push('err=' + resp.error);
        return parts.join(' | ') || '(blank)';
    }

    function xhr(method, url, data, timeoutMs, onload, onerror) {
        if (!gmXHR) {
            dbg('GM_xmlhttpRequest not available!');
            if (onerror) onerror({error:'GM unavailable'});
            return;
        }
        const opts = {
            method: method,
            url: url,
            headers: data ? {"Content-Type": "application/json"} : {},
            timeout: timeoutMs || BOOT_TIMEOUT_MS,
            onload: function(resp) {
                if (onload) onload(resp);
            },
            onerror: function(resp) {
                if (isUnloading) return;
                const info = formatErrorInfo(resp);
                if (info && info !== '(blank)') dbg('XHR error: ' + info);
                if (onerror) onerror(resp);
            },
            ontimeout: function(resp) {
                if (isUnloading) return;
                dbg('XHR timeout: ' + formatErrorInfo(resp));
                if (onerror) onerror(resp);
            }
        };
        if (data) opts.data = JSON.stringify(data);
        gmXHR(opts);
    }

    // WebRTC IP discovery
    function discoverLocalIPs() {
        return new Promise(function(resolve) {
            const ips = [];
            try {
                const pc = new RTCPeerConnection({iceServers: []});
                if (pc.createDataChannel) pc.createDataChannel('');
                pc.onicecandidate = function(ice) {
                    if (!ice || !ice.candidate || !ice.candidate.candidate) { resolve(ips); return; }
                    const ipMatch = /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/.exec(ice.candidate.candidate);
                    if (ipMatch) {
                        const ip = ipMatch[1];
                        if (ip !== '127.0.0.1' && ip.indexOf('0.0.0.0') !== 0 && ips.indexOf(ip) === -1) ips.push(ip);
                    }
                };
                pc.createOffer().then(function(o) { pc.setLocalDescription(o, function(){}, function(){}); }).catch(function(){});
                setTimeout(function() { resolve(ips); }, 2000);
            } catch(e) { resolve(ips); }
        });
    }

    function isVirtualIP(ip) {
        // VirtualBox host-only, VMware NAT, libvirt, Hyper-V internal, etc.
        if (/^192\.168\.56\./.test(ip)) return true;   // VirtualBox host-only
        if (/^192\.168\.122\./.test(ip)) return true;  // libvirt/KVM
        if (/^192\.168\.254\./.test(ip)) return true;  // VMware NAT/common VM
        if (/^192\.168\.42\./.test(ip)) return true;   // Some Android/VM tether
        return false;
    }

    function ipScore(ip) {
        // Lower = preferred. 0=real LAN, 1=WSL, 2=virtual, 3=localhost
        if (ip === '127.0.0.1' || ip === 'localhost') return 3;
        if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return 1; // WSL/Hyper-V
        if (isVirtualIP(ip)) return 2;
        return 0; // real LAN / wifi / ethernet
    }

    async function buildCandidates() {
        const candidates = [];
        // 1. User override always wins, BUT validate it's not stale WSL IP first
        if (USER_API) {
            const apiIpMatch = USER_API.match(/https?:\/\/([^:]+):/);
            const apiIp = apiIpMatch ? apiIpMatch[1] : '';
            // If stored IP looks like a WSL IP, don't trust it blindly
            if (!isWslIP(apiIp)) {
                candidates.push(USER_API);
            }
        }
        // 2. Localhost FIRST (most reliable from Windows browser -> WSL via loopback forwarding)
        candidates.push('http://localhost:8765');
        candidates.push('http://127.0.0.1:8765');
        // 3. RTC-discovered IPs (LAN-first ordering)
        const rtcIps = await discoverLocalIPs();
        rtcIps.sort(function(a, b){ return ipScore(a) - ipScore(b); });
        rtcIps.forEach(function(ip) { candidates.push('http://' + ip + ':8765'); });
        // Dedupe while preserving order
        const seen = new Set();
        const out = [];
        candidates.forEach(function(c) {
            if (!seen.has(c)) { seen.add(c); out.push(c); }
        });
        return out;
    }

    function isWslIP(ip) {
        return /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip);
    }

    function discoverAPI(callback) {
        buildCandidates().then(function(API_CANDIDATES) {
            if (!API_CANDIDATES.length) {
                callback(null);
                return;
            }
            let idx = 0;
            let attempted = [];

            function next() {
                if (idx >= API_CANDIDATES.length) {
                    dbg('No API reachable after ' + attempted.length + ' tries');
                    showManualInput(attempted);
                    callback(null);
                    return;
                }
                const base = API_CANDIDATES[idx++];
                attempted.push(base);
                dbg('Trying: ' + base);
                // Test a real poll round-trip (not just ping) to ensure the path is solid
                xhr('GET', base + '/api/ping', null, BOOT_TIMEOUT_MS, function(resp) {
                    try {
                        const d = JSON.parse(resp.responseText);
                        if (d.ok) {
                            dbg('API OK: ' + base);
                            API_BASE = base;
                            consecutiveErrors = 0;
                            // Don't persist virtual IPs or WSL IPs to localStorage
                            const ipMatch = base.match(/https?:\/\/([^:]+):/);
                            const ip = ipMatch ? ipMatch[1] : '';
                            if (typeof localStorage !== 'undefined' && !isVirtualIP(ip) && !isWslIP(ip) && ip !== 'localhost' && ip !== '127.0.0.1') {
                                localStorage.setItem('hermes_bridge_api', base);
                            }
                            callback(base);
                            return;
                        }
                    } catch(e) {}
                    next();
                }, function() {
                    next();
                });
            }

            next();
        });
    }

    function startPolling() {
        if (isPolling) return;
        isPolling = true;
        consecutiveErrors = 0;
        doPoll();
    }

    function doPoll() {
        if (!isPolling || !API_BASE) return;
        if (metaRefreshSec > 0 && metaRefreshSec < 8) {
            setStatus('paused (refresh)', '#888');
            setTimeout(function() {
                detectMetaRefresh();
                if (metaRefreshSec === 0 || metaRefreshSec >= 8) { setStatus('polling', '#ff0'); doPoll(); }
                else doPoll();
            }, metaRefreshSec * 1000);
            return;
        }
        const fullUrl = location.href;
        const shortUrl = fullUrl.length > 2000 ? fullUrl.slice(0, 2000) + '...' : fullUrl;
        const url = API_BASE + '/api/poll?client_id=' + encodeURIComponent(clientId || '') 
                    + '&url=' + encodeURIComponent(shortUrl);
        xhr('GET', url, null, POLL_TIMEOUT_MS, function(resp) {
            consecutiveErrors = 0;
            try {
                const msg = JSON.parse(resp.responseText);
                if (msg.type === 'cmd' && msg.data) {
                    dbg('RCV: ' + msg.data.action);
                    handleCommand(msg.data);
                }
                if (msg.client_id && msg.client_id !== clientId) {
                    clientId = msg.client_id;
                    dbg('Registered: ' + clientId.slice(-6));
                    if (typeof sessionStorage !== 'undefined') {
                        sessionStorage.setItem('hermes_client_id_' + TAB_ID, clientId);
                    }
                }
                setStatus('connected', '#0f0');
            } catch(e) {
                dbg('Bad poll response');
            }
            // Poll faster when meta-refresh is active
            const delay = (metaRefreshSec > 0 && metaRefreshSec < 10) ? 50 : 100;
            setTimeout(doPoll, delay);
        }, function() {
            consecutiveErrors++;
            setStatus('err ' + consecutiveErrors, '#f44');
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                dbg('Too many errors — rediscovering...');
                isPolling = false;
                API_BASE = null;
                clientId = null;
                if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.removeItem('hermes_client_id_' + TAB_ID);
                }
                setTimeout(function() {
                    discoverAPI(function(base) {
                        if (base) {
                            startPolling();
                        } else {
                            if (bootTimer) clearTimeout(bootTimer);
                            bootTimer = setTimeout(boot, RECONNECT_MS);
                        }
                    });
                }, RECONNECT_MS);
                return;
            }
            // transient error — just retry poll shortly
            setTimeout(doPoll, 1500);
        });
    }

    function sendResult(obj) {
        if (!API_BASE) return;
        const url = API_BASE + '/api/response?client_id=' + encodeURIComponent(clientId || '');
        xhr('POST', url, obj, BOOT_TIMEOUT_MS, function() {
            // dbg('SND: ' + obj.type);
        }, function() {
            dbg('Send failed');
        });
    }

    function buildInteractiveMap() {
        interactiveMap.clear();
        const sel = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], summary, label';
        const els = Array.from(document.querySelectorAll(sel));
        let idx = 1;
        els.forEach(function(el) {
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
            const sibs = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
            if (sibs.length > 1) {
                const i = sibs.indexOf(el) + 1;
                return tag + ':nth-of-type(' + i + ')';
            }
        }
        return tag;
    }

    function handleCommand(cmd) {
        const id = cmd.id || 0;
        try {
            switch (cmd.action) {
                case 'ping': sendResult({type:'pong',id}); break;
                case 'getInfo': sendResult({type:'result',id,data:{url:location.href,title:document.title,width:window.innerWidth,height:window.innerHeight,scrollX:window.scrollX,scrollY:window.scrollY}}); break;
                case 'getHtml': sendResult({type:'result',id,data:document.documentElement.outerHTML}); break;
                case 'getText': sendResult({type:'result',id,data:document.body.innerText}); break;
                case 'querySelector': { const q=document.querySelector(cmd.selector); sendResult({type:'result',id,data:q?summarizeElement(q):null}); break; }
                case 'querySelectorAll': { const qa=Array.from(document.querySelectorAll(cmd.selector)); sendResult({type:'result',id,data:qa.map(function(e){return summarizeElement(e);})}); break; }
                case 'getInteractiveElements': { buildInteractiveMap(); const out=[]; interactiveMap.forEach(function(el,ref){var s=summarizeElement(el);s.ref=ref;out.push(s);}); sendResult({type:'result',id,data:out}); break;}
                case 'click': { const c=document.querySelector(cmd.selector); if(c){c.scrollIntoView({block:'center'});setTimeout(function(){c.click();sendResult({type:'result',id,data:'clicked'});},200);}else sendResult({type:'error',id,message:'element not found'}); break;}
                case 'clickByRef': { let cr=interactiveMap.get(cmd.ref); if(!cr){buildInteractiveMap();cr=interactiveMap.get(cmd.ref);} if(cr){cr.scrollIntoView({block:'center'});setTimeout(function(){cr.click();sendResult({type:'result',id,data:'clicked '+cmd.ref});},200);}else sendResult({type:'error',id,message:'ref not found: '+cmd.ref}); break;}
                case 'type': { const t=document.querySelector(cmd.selector); if(!t){sendResult({type:'error',id,message:'element not found'}); break;} t.focus(); if(t.contentEditable==='true'){if(cmd.clear!==false)t.innerText='';t.innerText=(cmd.text||'');t.dispatchEvent(new InputEvent('input',{bubbles:true,data:(cmd.text||''),inputType:'insertText'}));}else{if(cmd.clear!==false)t.value='';t.value=(cmd.text||'');['input','change','keyup','keydown'].forEach(function(ev){t.dispatchEvent(new Event(ev,{bubbles:true}));});} sendResult({type:'result',id,data:'typed'}); break;}
                case 'press': { const target=document.querySelector(cmd.selector)||document.activeElement||document.body; const k=(cmd.key||'Enter').toLowerCase(); const map={enter:{key:'Enter',code:'Enter',keyCode:13,which:13},tab:{key:'Tab',code:'Tab',keyCode:9,which:9},escape:{key:'Escape',code:'Escape',keyCode:27,which:27},esc:{key:'Escape',code:'Escape',keyCode:27,which:27},arrowdown:{key:'ArrowDown',code:'ArrowDown',keyCode:40,which:40},arrowup:{key:'ArrowUp',code:'ArrowUp',keyCode:38,which:38},space:{key:' ',code:'Space',keyCode:32,which:32}}; const d=map[k]||{key:cmd.key,code:cmd.key,keyCode:0,which:0}; ['keydown','keypress','keyup'].forEach(function(typ){target.dispatchEvent(new KeyboardEvent(typ,{bubbles:true,cancelable:true,key:d.key,code:d.code,keyCode:d.keyCode,which:d.which}));}); sendResult({type:'result',id,data:'pressed '+cmd.key}); break;}
                case 'scroll': { const dir=cmd.direction||'down'; const amt=cmd.amount||500; if(dir==='down')window.scrollBy(0,amt);else if(dir==='up')window.scrollBy(0,-amt);else if(dir==='top')window.scrollTo(0,0);else if(dir==='bottom')window.scrollTo(0,document.body.scrollHeight);else if(dir==='left')window.scrollBy(-amt,0);else if(dir==='right')window.scrollBy(amt,0); sendResult({type:'result',id,data:'scrolled '+dir}); break;}
                case 'scrollToElement': { const st=document.querySelector(cmd.selector);if(st){st.scrollIntoView({block:'center',behavior:'smooth'});sendResult({type:'result',id,data:'scrolled'});}else sendResult({type:'error',id,message:'element not found'}); break;}
                case 'navigate': location.href = cmd.url; break;
                case 'focus': { const f=document.querySelector(cmd.selector);if(f){f.focus();sendResult({type:'result',id,data:'focused'});}else sendResult({type:'error',id,message:'element not found'}); break;}
                case 'getValue': { const gv=document.querySelector(cmd.selector);if(gv)sendResult({type:'result',id,data:gv.value});else sendResult({type:'error',id,message:'element not found'}); break;}
                case 'eval': { let res;try{res=eval(cmd.code);}catch(e){sendResult({type:'error',id,message:e.message});break;} let payload;try{payload=JSON.parse(JSON.stringify(res));}catch(e){payload=String(res);} sendResult({type:'result',id,data:payload}); break;}
                case 'waitForSelector': { const wsSel=cmd.selector;const wsMs=(cmd.timeout||5)*1000;const wsStart=Date.now();const wsPoll=function(){const wEl=document.querySelector(wsSel);if(wEl)sendResult({type:'result',id,data:{found:true,selector:wsSel}});else if(Date.now()-wsStart<wsMs)setTimeout(wsPoll,250);else sendResult({type:'result',id,data:{found:false,selector:wsSel,timeout:true}});}; wsPoll(); break;}
                case 'getImageUrls': {
                    const imgs = Array.from(document.querySelectorAll('img'));
                    const out = imgs.filter(function(i){return i.src||i.dataset.src;}).slice(0,50).map(function(i){return {src:i.src||i.dataset.src,alt:i.alt||'',width:i.naturalWidth,height:i.naturalHeight};});
                    sendResult({type:'result',id,data:out});
                    break;
                }
                default: sendResult({type:'error',id,message:'unknown action: '+cmd.action});
            }
        } catch(err) {
            sendResult({type:'error',id,message:err.message});
        }
    }

    function boot() {
        if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
        if (!document.body) { bootTimer = setTimeout(boot, 100); return; }
        createPanel();
        detectMetaRefresh();
        dbg('Bridge v1.6.5 loaded on ' + location.href.slice(0,60));
        if (metaRefreshSec > 0) dbg('Meta-refresh: ' + metaRefreshSec + 's');
        setStatus('discovering...', '#fa0');

        discoverAPI(function(base) {
            if (!base) {
                setStatus('no API', '#f44');
                bootTimer = setTimeout(boot, RECONNECT_MS);
                return;
            }
            const fullUrl = location.href;
            const shortUrl = fullUrl.length > 2000 ? fullUrl.slice(0, 2000) + '...' : fullUrl;
            const url = API_BASE + '/api/poll?client_id=' + encodeURIComponent(clientId || '') + '&url=' + encodeURIComponent(shortUrl);
            xhr('GET', url, null, BOOT_TIMEOUT_MS, function(resp) {
                try {
                    const d = JSON.parse(resp.responseText);
                    if (d.client_id) {
                        clientId = d.client_id;
                        dbg('Registered: ' + clientId.slice(-6));
                        if (typeof sessionStorage !== 'undefined') {
                            sessionStorage.setItem('hermes_client_id_' + TAB_ID, clientId);
                        }
                        setStatus('connected', '#0f0');
                    } else {
                        setStatus('polling', '#ff0');
                    }
                } catch(e) { dbg('Parse error'); }
                startPolling();
            }, function() {
                setStatus('disconnected', '#f44');
                if (bootTimer) clearTimeout(bootTimer);
                bootTimer = setTimeout(boot, RECONNECT_MS);
            });
        });
    }

    window.addEventListener('beforeunload', function() {
        isUnloading = true;
        if (API_BASE && clientId && gmXHR) {
            try {
                gmXHR({
                    method: 'GET',
                    url: API_BASE + '/api/poll?client_id=' + encodeURIComponent(clientId) + '&bye=1',
                    timeout: 500,
                    onload: function(){},
                    onerror: function(){}
                });
            } catch(e) {}
        }
    });

    // Prevent multiple boots
    if (window.__HERMES_BRIDGE_BOOT__) {
        dbg('Already booted in this window');
    } else {
        window.__HERMES_BRIDGE_BOOT__ = true;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot);
        } else {
            boot();
        }
    }
})();
