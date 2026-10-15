/**
 * background.js — Service Worker
 *
 * Routes messages between the native messaging host (Python HTTP server)
 * and the content script (which relays to the Canvas iframe).
 *
 * Robust RAM / V8 Heap Hygiene & Zero-Downtime Tab Recycler:
 *   - Tracks in-flight API requests (never reloads while a prompt is processing)
 *   - Recycles Gemini tab every 50 requests or every 30m with 25s idle
 *   - Queues incoming requests during recycling and drains immediately on page_ready
 *   - Auto-expires chunk buffers after 60s TTL to prevent memory leaks on aborted agent calls
 *   - Prevents cgroup OOM crashes permanently without losing auth or session cookies
 */

let nativePort = null;
let canvasTabId = null;
let appConfig = { target_chat_id: '', canvas_card_name: '' };

// Tabs we already injected content_script.js into
const injectedTabs = new Set();

// ── In-Flight Tracking & Queued Recycler State ────────────────────────────────
const inFlightRequests = new Set();
const pendingQueue = [];
let requestCounter = 0;
let isRecycling = false;
let recyclingSince = 0;

const RECYCLE_REQUEST_THRESHOLD = 50;           // Recycle every 50 completed requests
const RECYCLE_TIME_THRESHOLD_MS = 30 * 60 * 1000; // or every 30 minutes...
const SHORT_IDLE_MS = 25 * 1000;                 // ...if idle for just 25 seconds between agent turns

let lastSoftReloadAt = Date.now();
let lastActivityAt = Date.now();

function touchActivity() {
    lastActivityAt = Date.now();
}

// ── Native messaging host connection ─────────────────────────────────────────

function connectNative() {
    if (nativePort) return;

    try {
        nativePort = chrome.runtime.connectNative('com.gemini.proxy');
        console.log('[Proxy] Connected to native host');
    } catch (e) {
        console.error('[Proxy] Failed to connect to native host:', e);
        setTimeout(connectNative, 3000);
        return;
    }

    nativePort.onMessage.addListener((msg) => {
        if (msg.type === 'host_ready') {
            console.log('[Proxy] Host ready, port:', msg.port);
            if (msg.config) {
                appConfig = {
                    target_chat_id: msg.config.target_chat_id || '',
                    canvas_card_name: msg.config.canvas_card_name || ''
                };
                console.log('[Proxy] Config loaded from host:', appConfig);
            }
        } else if (msg.type === 'api_request' || msg.type === 'api_request_chunk') {
            handleApiRequest(msg);
        }
    });

    nativePort.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Clean disconnect';
        console.warn('[Proxy] Native host disconnected:', err);
        nativePort = null;
        setTimeout(connectNative, 3000);
    });

    // Handshake: send init message so native host knows we're ready
    try {
        nativePort.postMessage({ type: 'init' });
    } catch (e) {
        console.warn('[Proxy] Failed to send init:', e.message);
    }
}

// ── Chunk Buffer (with TTL Eviction) ──────────────────────────────────────────

const chunkBuffer = {};
const CHUNK_TTL_MS = 60 * 1000;

function cleanChunkBuffer() {
    const now = Date.now();
    for (const id in chunkBuffer) {
        if (now - chunkBuffer[id].createdAt > CHUNK_TTL_MS) {
            console.warn(`[Proxy] Evicting expired chunk buffer for request ${id} (aborted/cancelled by client)`);
            delete chunkBuffer[id];
        }
    }
}

// ── Content Script Injection Cache ───────────────────────────────────────────

async function ensureContentScript(tabId) {
    if (injectedTabs.has(tabId)) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            files: ['content_script.js']
        });
        injectedTabs.add(tabId);
        console.log('[Proxy] Injected content_script into tab', tabId);
    } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        if (/Cannot access contents|Frame with ID|No tab with id/i.test(msg)) {
            // leave uncached so a later navigation can retry
        } else {
            injectedTabs.add(tabId);
        }
        console.warn('[Proxy] executeScript note:', msg);
    }
}

// ── Tab Recycling & Queue Draining ───────────────────────────────────────────

async function recycleTab(reason) {
    if (isRecycling || !canvasTabId) return;
    if (inFlightRequests.size > 0) {
        console.log(`[Proxy] Tab recycle postponed: ${inFlightRequests.size} requests still in flight`);
        return;
    }

    isRecycling = true;
    recyclingSince = Date.now();
    console.log(`[Proxy] ♻️ Recycling Gemini tab to reclaim V8 heap (${reason}). In-flight: 0, completed: ${requestCounter}`);
    
    injectedTabs.delete(canvasTabId);
    requestCounter = 0;
    lastSoftReloadAt = Date.now();

    try {
        await chrome.tabs.reload(canvasTabId);
    } catch (e) {
        console.warn('[Proxy] Soft reload failed:', e.message);
        isRecycling = false;
    }
}

async function drainPendingQueue() {
    if (isRecycling || !canvasTabId) return;
    if (pendingQueue.length === 0) return;

    console.log(`[Proxy] 🚀 Draining pending request queue (${pendingQueue.length} queued requests)`);
    while (pendingQueue.length > 0 && !isRecycling && canvasTabId) {
        const nextMsg = pendingQueue.shift();
        dispatchToTab(nextMsg);
    }
}

// ── API Request Dispatcher ───────────────────────────────────────────────────

async function dispatchToTab(msg) {
    if (!canvasTabId) {
        await discoverCanvasTab();
    }

    if (!canvasTabId) {
        const err = 'No Canvas tab found. Open gemini.google.com, paste proxy HTML in Code view, click Preview.';
        console.error('[Proxy]', err);
        if (nativePort) {
            nativePort.postMessage({ type: 'api_response', id: msg.id, error: err });
        }
        return;
    }

    await ensureContentScript(canvasTabId);
    touchActivity();
    inFlightRequests.add(msg.id);

    try {
        await chrome.tabs.sendMessage(canvasTabId, {
            type: 'api_request',
            id: msg.id,
            method: msg.method,
            path: msg.path,
            body: msg.body,
            headers: msg.headers || {}
        });
    } catch (err) {
        console.warn('[Proxy] Failed to send to tab:', err.message);
        injectedTabs.delete(canvasTabId);
        try {
            await ensureContentScript(canvasTabId);
            await chrome.tabs.sendMessage(canvasTabId, {
                type: 'api_request',
                id: msg.id,
                method: msg.method,
                path: msg.path,
                body: msg.body,
                headers: msg.headers || {}
            });
        } catch (err2) {
            inFlightRequests.delete(msg.id);
            if (nativePort) {
                nativePort.postMessage({
                    type: 'api_response',
                    id: msg.id,
                    error: 'Canvas tab not responding. Make sure proxy HTML is in Canvas Preview. Error: ' + err2.message
                });
            }
        }
    }
}

async function handleApiRequest(msg) {
    if (msg.type === 'api_request_chunk') {
        if (!chunkBuffer[msg.id]) {
            chunkBuffer[msg.id] = { chunks: [], total: msg.total_chunks, createdAt: Date.now() };
        }
        chunkBuffer[msg.id].chunks[msg.chunk_index] = msg.chunk_data;

        const buf = chunkBuffer[msg.id];
        const received = buf.chunks.filter(c => c !== undefined).length;
        console.log(`[Proxy] Chunk ${msg.chunk_index + 1}/${msg.total_chunks} received (${received}/${buf.total})`);

        if (received < buf.total) return;

        const fullJson = buf.chunks.join('');
        delete chunkBuffer[msg.id];
        console.log('[Proxy] All chunks reassembled, size:', fullJson.length, 'bytes');

        try {
            msg = JSON.parse(fullJson);
        } catch (e) {
            console.error('[Proxy] Failed to parse reassembled payload:', e);
            if (nativePort) {
                nativePort.postMessage({ type: 'api_response', id: msg.id, error: 'Chunk reassembly parse failed' });
            }
            return;
        }
    }

    // If currently recycling, buffer request in pending queue (zero client errors)
    if (isRecycling || !canvasTabId) {
        console.log(`[Proxy] ⏳ Tab currently recycling or not ready. Enqueueing request ${msg.id} (queue length: ${pendingQueue.length + 1})`);
        pendingQueue.push(msg);
        return;
    }

    dispatchToTab(msg);
}

// ── Canvas Tab Discovery ─────────────────────────────────────────────────────

function discoverCanvasTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ url: ['https://gemini.google.com/*'] }, (tabs) => {
            for (const tab of tabs) {
                if (!tab.url) continue;
                canvasTabId = tab.id;
                console.log('[Proxy] Found Gemini tab:', canvasTabId, tab.url.substring(0, 60));
                resolve(tab.id);
                return;
            }
            console.warn('[Proxy] No Gemini tab found among', tabs.length, 'tabs');
            canvasTabId = null;
            resolve(null);
        });
    });
}

// ── Message Listeners (from content script) ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'get_config') {
        sendResponse(appConfig);
        return false;
    }

    if (message.type === 'page_ready') {
        if (sender && sender.tab && sender.tab.id != null) {
            canvasTabId = sender.tab.id;
            injectedTabs.add(sender.tab.id);
        }
        console.log('[Proxy] Canvas proxy page ready, tab:', canvasTabId);
        isRecycling = false;
        recyclingSince = 0;

        if (nativePort) {
            try { nativePort.postMessage({ type: 'page_ready', tabId: canvasTabId }); } catch (e) {}
        }
        sendResponse({ ok: true });

        // Immediately drain any requests queued during the reload
        drainPendingQueue();
        return false;
    }

    if (message.type === 'api_response') {
        inFlightRequests.delete(message.id);
        requestCounter++;
        touchActivity();

        if (nativePort) {
            try {
                nativePort.postMessage({
                    type: 'api_response',
                    id: message.id,
                    status: message.status,
                    data: message.data,
                    error: message.error
                });
            } catch (e) {
                console.warn('[Proxy] Failed to post to native host:', e.message);
            }
        }

        // Proactive recycling: if request threshold reached and no other requests are running
        if (inFlightRequests.size === 0 && requestCounter >= RECYCLE_REQUEST_THRESHOLD) {
            recycleTab(`${requestCounter} completed requests threshold`);
        }

        return false;
    }

    return false;
});

// ── Tab Lifecycle Tracking ───────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
        injectedTabs.delete(tabId);
    }
    if (tab.url) {
        const url = tab.url.toLowerCase();
        if (url.includes('gemini.google.com')) {
            canvasTabId = tabId;
        } else if (tabId === canvasTabId) {
            canvasTabId = null;
            injectedTabs.delete(tabId);
        }
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    injectedTabs.delete(tabId);
    if (tabId === canvasTabId) {
        console.log('[Proxy] Canvas tab closed');
        canvasTabId = null;
        isRecycling = false;
    }
});

// ── Periodic Maintenance & Heap Hygiene (Every 10 Seconds) ───────────────────

setInterval(async () => {
    // 1. Evict stale chunk buffers
    cleanChunkBuffer();

    // 2. Safety Watchdog: If recycling stuck for > 30s, reset flag and retry
    if (isRecycling && recyclingSince > 0 && Date.now() - recyclingSince > 30 * 1000) {
        console.warn('[Proxy] ⚠️ Recycle safety timeout (30s). Resetting recycle lock and discovering tab...');
        isRecycling = false;
        recyclingSince = 0;
        await discoverCanvasTab();
        drainPendingQueue();
        return;
    }

    // 3. Time + Idle based proactive recycling
    if (!canvasTabId || isRecycling) return;
    if (inFlightRequests.size > 0 || pendingQueue.length > 0) return;

    const now = Date.now();
    const timeSinceLastReload = now - lastSoftReloadAt;
    const idleDuration = now - lastActivityAt;

    if (
        (timeSinceLastReload > RECYCLE_TIME_THRESHOLD_MS && idleDuration > SHORT_IDLE_MS) ||
        (requestCounter >= RECYCLE_REQUEST_THRESHOLD)
    ) {
        recycleTab(
            requestCounter >= RECYCLE_REQUEST_THRESHOLD
                ? `${requestCounter} requests reached`
                : `${Math.round(timeSinceLastReload / 60000)}m runtime + ${Math.round(idleDuration / 1000)}s idle`
        );
    }
}, 10 * 1000);

// ── Startup ──────────────────────────────────────────────────────────────────

connectNative();
discoverCanvasTab();
