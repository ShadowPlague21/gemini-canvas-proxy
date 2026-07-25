/**
 * content_script.js — PostMessage Relay & Hands-Free Auto-Clicker
 *
 * This script runs in the top-level Gemini page (gemini.google.com).
 * It relays messages between background.js and the Canvas iframe,
 * and automatically navigates into the target chat thread & opens Canvas Preview.
 */

// ── 1. Listen for messages from the Canvas iframe (via postMessage) ────────────

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    // Canvas proxy page is ready — notify background
    if (data.source === 'gemini-proxy-ready') {
        window.__geminiProxyReady = true;
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

// ── 2. Listen for messages from background (API requests to forward to iframe) ──

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

        // Send to ALL iframes — the Canvas preview iframe will pick it up
        document.querySelectorAll('iframe').forEach(iframe => {
            try { iframe.contentWindow.postMessage(payload, '*'); } catch (e) {}
        });

        // Also send to main window
        window.postMessage(payload, '*');
    }
});

// ── 3. Automatic Navigation & Canvas Card Clicker ──────────────────────────

// Defaults empty; set via native host / extension config (TARGET_CHAT_ID, CANVAS_CARD_NAME)
let targetChatId = '';
let canvasCardName = '';

function autoClickCanvasCard() {
    // Only run in top window
    if (window.self !== window.top) return;

    // If proxy iframe is already active and ready, no clicking needed
    if (window.__geminiProxyReady) return;

    // A. Check for 'Preview' tab button if Canvas code tab is open
    const tabButtons = document.querySelectorAll('button, div, span, a, [role="tab"], [role="button"]');
    for (const el of tabButtons) {
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt === 'preview') {
            const clickable = el.closest('button') || el.closest('[role="tab"]') || el;
            console.log("[Canvas Proxy Extension] Found 'Preview' button, clicking:", clickable);
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventType => {
                clickable.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
            });
            return;
        }
    }

    // B. Look for chat link or recents link in sidebar if not in target chat thread
    if (targetChatId && !window.location.pathname.includes(targetChatId)) {
        const chatLink = document.querySelector(`a[href*="${targetChatId}"]`);
        if (chatLink) {
            console.log("[Canvas Proxy Extension] Found target chat link, clicking:", chatLink);
            chatLink.click();
            return;
        } else {
            // Expand sidebar if closed
            const sidebarToggle = document.querySelector('[aria-label*="sidebar" i], [aria-label*="menu" i], [title*="sidebar" i]');
            if (sidebarToggle) {
                const label = (sidebarToggle.getAttribute('aria-label') || '').toLowerCase();
                const title = (sidebarToggle.getAttribute('title') || '').toLowerCase();
                if (label.includes('open') || label.includes('expand') || title.includes('open') || title.includes('expand')) {
                    console.log("[Canvas Proxy Extension] Opening sidebar:", sidebarToggle);
                    sidebarToggle.click();
                    return;
                }
            }
        }
    }

    // C. Look for target Canvas card on the chat page
    const candidates = document.querySelectorAll('div, span, button, p, h1, h2, h3, h4, h5, h6, a, [role="button"]');
    const targetLower = canvasCardName.trim().toLowerCase();
    
    for (const el of candidates) {
        if (!el.textContent) continue;
        const text = el.textContent.trim().toLowerCase();

        if (text === targetLower || (el.children.length <= 3 && text.includes(targetLower))) {
            const clickable = el.closest('button') || el.closest('[role="button"]') || el.closest('a') || el;
            console.log("[Canvas Proxy Extension] Found Canvas card, auto-clicking:", clickable);
            
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventType => {
                clickable.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
            });
            break;
        }
    }
}

// Check every 1.5 seconds hands-free
setInterval(() => {
    try {
        chrome.runtime.sendMessage({ type: 'get_config' }, (config) => {
            if (config) {
                if (config.target_chat_id) targetChatId = config.target_chat_id;
                if (config.canvas_card_name) canvasCardName = config.canvas_card_name;
            }
        });
    } catch (e) {}
    
    autoClickCanvasCard();
}, 1500);
