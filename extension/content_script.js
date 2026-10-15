/**
 * content_script.js — PostMessage Relay & Hands-Free Auto-Clicker
 *
 * This script runs in the top-level Gemini page (gemini.google.com).
 * It relays messages between background.js and the Canvas iframe,
 * and automatically navigates into the target chat thread & opens Canvas Preview.
 */

// ── CPU / RAM Saver: Suppress CSS animations, transitions & blinking carets in headless Xvfb ──
function injectResourceSaver() {
    try {
        if (document.getElementById('gemini-resource-saver')) return;
        const style = document.createElement('style');
        style.id = 'gemini-resource-saver';
        style.textContent = `
            *, *::before, *::after {
                animation-duration: 0.0001s !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.0001s !important;
                caret-color: transparent !important;
            }
            .monaco-editor .cursors-layer .cursor {
                visibility: hidden !important;
                animation: none !important;
            }
            canvas:not([id*="preview"]):not([class*="preview"]) {
                display: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    } catch (e) {}
}
injectResourceSaver();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectResourceSaver);
}

function safeSendMessage(payload, callback) {
    try {
        if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
            const res = chrome.runtime.sendMessage(payload, callback);
            if (res && typeof res.catch === 'function') {
                res.catch(() => {});
            }
        }
    } catch (e) {
        // Silently ignore context invalidation after extension reload
    }
}

function dispatchFullClick(el) {
    if (!el) return;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventType => {
        el.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
    });
}

function isVisible(el) {
    if (!el) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

// ── 1. Listen for messages from the Canvas iframe (via postMessage) ────────────

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    // Canvas proxy page is ready — notify background
    if (data.source === 'gemini-proxy-ready') {
        window.__geminiProxyReady = true;
        safeSendMessage({ type: 'page_ready' });
        return;
    }

    // API response from the Canvas proxy page — forward to background
    if (data.source === 'gemini-proxy-response') {
        safeSendMessage({
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

// Defaults set via native host / extension config (TARGET_CHAT_ID, CANVAS_CARD_NAME)
let targetChatId = '22fd39af5fecaef2';
let canvasCardName = 'Hi Webapp';
let targetChatName = 'Minimal HTML Web App Creation';

function autoClickCanvasCard() {
    // Only run in top window
    if (window.self !== window.top) return;

    // Only guard if user is actively typing inside Monaco code editor in Canvas pane
    const active = document.activeElement;
    if (active && active.closest('.monaco-editor, .code-editor')) {
        return;
    }

    // If proxy iframe is already active or ready, no clicking needed
    if (window.__geminiProxyReady) return;
    if (document.querySelector('iframe[src*="blob:"], iframe[title*="preview" i], iframe[title*="sandbox" i]')) return;

    // ── STEP 1: Check for 'Preview' tab button if Canvas code tab is open ──
    const tabButtons = document.querySelectorAll('button, div, span, a, [role="tab"], [role="button"]');
    for (const el of tabButtons) {
        if (!isVisible(el)) continue;
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt === 'preview') {
            const clickable = el.closest('button') || el.closest('[role="tab"]') || el;
            // If Preview tab is ALREADY selected or active — DO NOT fire click events!
            const isSelected = clickable.getAttribute('aria-selected') === 'true' || 
                               clickable.getAttribute('aria-pressed') === 'true' ||
                               clickable.classList.contains('selected') ||
                               clickable.classList.contains('active');
            if (isSelected) {
                return;
            }
            console.log("[Canvas Proxy Extension] Found unselected 'Preview' button, clicking once:", clickable);
            dispatchFullClick(clickable);
            return;
        }
    }

    // ── STEP 2: Check for target Canvas Card ("Hi Webapp") on screen FIRST ──
    if (canvasCardName && canvasCardName.trim()) {
        const targetLower = canvasCardName.trim().toLowerCase();
        const candidates = document.querySelectorAll('div, span, button, p, h1, h2, h3, h4, h5, h6, a, [role="button"]');
        
        for (const el of candidates) {
            if (!isVisible(el) || !el.textContent) continue;
            const text = el.textContent.trim().toLowerCase();

            if (text === targetLower || (el.children.length <= 3 && text.includes(targetLower))) {
                const clickable = el.closest('button') || el.closest('[role="button"]') || el.closest('a') || el;
                if (!isVisible(clickable)) continue;
                console.log("[Canvas Proxy Extension] Found visible Canvas card ('" + canvasCardName + "'), clicking:", clickable);
                dispatchFullClick(clickable);
                return;
            }
        }
    }

    // ── STEP 3: If Canvas card not visible, look for target chat thread link in sidebar ──
    const targetChatLower = (targetChatName || '').trim().toLowerCase();
    const targetChatPrefix = targetChatLower.substring(0, 16);

    const chatLinks = document.querySelectorAll('a, button, div[role="button"], span, p, h2, h3');
    for (const el of chatLinks) {
        if (!isVisible(el)) continue;
        const href = el.getAttribute('href') || '';
        const txt = (el.textContent || '').trim().toLowerCase();

        if (
            (targetChatId && href.includes(targetChatId)) || 
            (targetChatLower && (txt.includes(targetChatLower) || (targetChatPrefix.length > 5 && txt.includes(targetChatPrefix))))
        ) {
            const clickable = el.closest('a') || el.closest('button') || el.closest('[role="button"]') || el;
            if (!isVisible(clickable)) continue;
            console.log("[Canvas Proxy Extension] Found visible target chat link, clicking:", clickable);
            dispatchFullClick(clickable);
            return;
        }
    }

    // ── STEP 4: Expand sidebar if no target chat link or card is visible ──
    const sidebarToggle = document.querySelector('button[aria-label*="menu" i], button[aria-label*="sidebar" i], button[aria-label*="nav" i], button[aria-label*="expand" i], button[aria-label*="main" i], .side-nav-toggle, [data-test-id*="menu" i]');
    if (sidebarToggle && isVisible(sidebarToggle)) {
        console.log("[Canvas Proxy Extension] Found visible sidebar toggle, clicking to expand:", sidebarToggle);
        dispatchFullClick(sidebarToggle);
        return;
    }
}

// Check every 2 seconds until proxy is ready, then completely back off
let navInterval = setInterval(() => {
    if (window.__geminiProxyReady) {
        clearInterval(navInterval);
        return;
    }
    safeSendMessage({ type: 'get_config' }, (config) => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) return;
        if (config) {
            if (config.target_chat_id) targetChatId = config.target_chat_id;
            if (config.canvas_card_name) canvasCardName = config.canvas_card_name;
            if (config.target_chat_name) targetChatName = config.target_chat_name;
        }
    });
    
    autoClickCanvasCard();
}, 2000);

function restartNavInterval() {
    if (navInterval) clearInterval(navInterval);
    navInterval = setInterval(() => {
        if (window.__geminiProxyReady) {
            clearInterval(navInterval);
            return;
        }
        autoClickCanvasCard();
    }, 2000);
}

window.addEventListener('popstate', () => { 
    window.__geminiProxyReady = false; 
    restartNavInterval();
});
window.addEventListener('beforeunload', () => { 
    window.__geminiProxyReady = false; 
});

const _origPushState = history.pushState;
history.pushState = function() {
    window.__geminiProxyReady = false;
    restartNavInterval();
    return _origPushState.apply(this, arguments);
};
const _origReplaceState = history.replaceState;
history.replaceState = function() {
    window.__geminiProxyReady = false;
    restartNavInterval();
    return _origReplaceState.apply(this, arguments);
};
