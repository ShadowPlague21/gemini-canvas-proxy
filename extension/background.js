/**
 * background.js — Service Worker
 *
 * Routes messages between the native messaging host (Python HTTP server)
 * and the content script (which relays to the Canvas iframe).
 *
 * Safe RAM / CPU optimizations (do not touch auth path):
 *   - executeScript only once per tab (cached)
 *   - content scripts limited to gemini.google.com via manifest
 *   - soft tab reload every few hours when idle (V8 heap reset)
 */

let nativePort = null;
let canvasTabId = null;
let appConfig = { target_chat_id: '', canvas_card_name: '' };

// Tabs we already injected content_script.js into (avoid re-inject on every API call)
const injectedTabs = new Set();

// Soft refresh: every 3h if no activity for 5+ minutes (idle only; does not touch cookies)
const SOFT_RELOAD_MS = 3 * 60 * 60 * 1000;
const SOFT_RELOAD_IDLE_MS = 5 * 60 * 1000;
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
        setTimeout(connectNative, 2000);
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
        console.warn('[Proxy] Native host disconnected, reconnecting...');
        nativePort = null;
        setTimeout(connectNative, 2000);
    });
}

// ── API request forwarding ───────────────────────────────────────────────────

const chunkBuffer = {};

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
        // "already injected" style failures: treat as cached so we stop retry-spamming
        if (/Cannot access contents|Frame with ID|No tab with id/i.test(msg)) {
            // leave uncached so a later navigation can retry
        } else {
            // Successful-enough / duplicate inject paths
            injectedTabs.add(tabId);
        }
        console.warn('[Proxy] executeScript note:', msg);
    }
}

async function handleApiRequest(msg) {
    if (msg.type === 'api_request_chunk') {
        if (!chunkBuffer[msg.id]) {
            chunkBuffer[msg.id] = { chunks: [], total: msg.total_chunks };
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
        // Tab may have been refreshed — clear inject cache and retry once
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

// ── Canvas tab discovery ─────────────────────────────────────────────────────

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

// ── Message listeners (from content script) ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'get_config') {
        sendResponse(appConfig);
        return;
    }

    if (message.type === 'page_ready') {
        canvasTabId = sender.tab.id;
        if (sender.tab && sender.tab.id != null) {
            injectedTabs.add(sender.tab.id);
        }
        console.log('[Proxy] Canvas proxy page ready, tab:', canvasTabId);
        if (nativePort) {
            nativePort.postMessage({ type: 'page_ready', tabId: canvasTabId });
        }
        sendResponse({ ok: true });
    }

    if (message.type === 'api_response') {
        touchActivity();
        if (nativePort) {
            nativePort.postMessage({
                type: 'api_response',
                id: message.id,
                status: message.status,
                data: message.data,
                error: message.error
            });
        }
    }

    return true;
});

// ── Tab lifecycle tracking ───────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
        // Navigation clears isolated world; re-inject next request
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
    }
});

// ── Soft tab reload (heap hygiene; idle only; does not touch cookies/auth) ───

setInterval(async () => {
    if (!canvasTabId) return;
    if (Object.keys(chunkBuffer).length > 0) return;
    const now = Date.now();
    if (now - lastSoftReloadAt < SOFT_RELOAD_MS) return;
    if (now - lastActivityAt < SOFT_RELOAD_IDLE_MS) return; // busy recently — skip

    console.log('[Proxy] Soft-reloading Gemini tab to reclaim V8 heap (idle 5m+, age 3h+)');
    lastSoftReloadAt = now;
    injectedTabs.delete(canvasTabId);
    try {
        await chrome.tabs.reload(canvasTabId);
    } catch (e) {
        console.warn('[Proxy] Soft reload failed:', e.message);
    }
}, 15 * 60 * 1000); // check every 15 minutes

// ── Start ────────────────────────────────────────────────────────────────────

connectNative();
discoverCanvasTab();
