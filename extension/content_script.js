/**
 * content_script.js — PostMessage Relay
 *
 * This script runs in the top-level Gemini page (gemini.google.com).
 * It cannot run inside the sandboxed Canvas iframe, but it CAN
 * communicate with it via postMessage (browser-level IPC, not blocked).
 *
 * Communication flow:
 *   Canvas iframe ──postMessage──→ This content script
 *                ←─────────────────
 *                         │ chrome.runtime.sendMessage
 *                         ▼
 *                   background.js (service worker)
 *
 * Deduplication is handled on the Canvas proxy page side (by request ID),
 * NOT here — we post to all iframes because the Canvas iframe is sandboxed
 * and event.source matching is unreliable across sandbox boundaries.
 */

// ── Listen for messages from the Canvas iframe (via postMessage) ────────────

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    // Canvas proxy page is ready — notify background
    if (data.source === 'gemini-proxy-ready') {
        chrome.runtime.sendMessage({ type: 'page_ready' });
        return;
    }

    // API response from the Canvas proxy page — forward to background
    if (data.source === 'gemini-proxy-response') {
        chrome.runtime.sendMessage({
            type: 'api_response',
            id: data.id,
            status: data.status,
            data: data.data,
            error: data.error
        });
        return;
    }
});

// ── Listen for messages from background (API requests to forward to iframe) ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'api_request') {
        const payload = {
            source: 'gemini-proxy-request',
            id: message.id,
            method: message.method,
            path: message.path,
            body: message.body,
            headers: message.headers
        };

        // Send to ALL iframes — the Canvas preview iframe will pick it up.
        // We post to all because sandbox cross-origin restrictions make
        // iframe.contentWindow matching unreliable. Deduplication is handled
        // on the Canvas proxy page by tracking request IDs.
        document.querySelectorAll('iframe').forEach(iframe => {
            try { iframe.contentWindow.postMessage(payload, '*'); } catch (e) {}
        });

        // Also send to main window (in case proxy code is in top-level page)
        window.postMessage(payload, '*');
    }
});
