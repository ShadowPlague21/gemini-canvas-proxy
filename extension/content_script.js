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
 * IMPORTANT: Only ONE content script instance runs in the top frame.
 * We track the proxy iframe by listening for its 'ready' message,
 * then only post to THAT specific iframe (not all iframes).
 */

// ── State ──────────────────────────────────────────────────────────────────

let proxyIframe = null;  // The specific iframe running our proxy page

// ── Listen for messages from the Canvas iframe (via postMessage) ────────────

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    // Canvas proxy page is ready — remember which iframe it is
    if (data.source === 'gemini-proxy-ready') {
        // Find the iframe that sent this message
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
            if (iframe.contentWindow === event.source) {
                proxyIframe = iframe;
                break;
            }
        }
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

        // Send ONLY to the identified proxy iframe (not all iframes)
        if (proxyIframe) {
            try {
                proxyIframe.contentWindow.postMessage(payload, '*');
            } catch (e) {
                // If the iframe was removed/reloaded, reset
                proxyIframe = null;
            }
        }
    }
});
