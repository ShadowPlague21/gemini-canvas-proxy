# Podman cheat sheet: Gemini Canvas Proxy

## Stable session persistence

Google login survives **container restarts** when all of these are true:

1. Chromium flag: **`--password-store=gnome-libsecret` only**  
   (never `basic` / `--use-mock-keychain` — those do not persist)
2. Entrypoint **waits for Secret Service** (unlocked gnome-keyring) before Chromium starts
3. Managed Chromium policy mounted at `/etc/chromium/policies`:
   - `BrowserSignin: 0`
   - `SyncDisabled: true`  
   (stops Account Reconcilor from wiping cookie-only sessions)
4. Persistent volumes: `browser-data/`, stable `machine-id`, and `chromium-policies/`

First-time setup: start VNC → sign into Gemini carefully → wait ~1 minute → restart the unit once to verify.

---

## VNC toggle (save RAM)

```bash
podman exec gemini-canvas-proxy /app/toggle-vnc.sh stop
podman exec gemini-canvas-proxy /app/toggle-vnc.sh start
podman exec gemini-canvas-proxy /app/toggle-vnc.sh status
```

`start` re-execs as the `proxy` user (same as Xvfb). Root hits MIT-SHM errors.

noVNC: `http://<host-ip>:6080/vnc.html`

---

## Service control

```bash
systemctl --user restart gemini-canvas-proxy.service
systemctl --user status gemini-canvas-proxy.service
journalctl --user -u gemini-canvas-proxy.service -n 80 --no-pager
```

Healthy boot log snippets:

- `Secret Service ready (login unlocked)`
- `password-store=gnome-libsecret`

Bad after restart (old bug):

- `PerformLogoutAllAccountsAction`
- immediate `ServiceLogin` / missing `.google.com` SID cookies

---

## Diagnostics

```bash
podman exec gemini-canvas-proxy ps aux
podman exec gemini-canvas-proxy cat /tmp/chromium.log
podman exec gemini-canvas-proxy cat /tmp/proxy.log
```

---

## Extension ID

```bash
podman exec gemini-canvas-proxy /app/setup-extension.sh <32-char-extension-id>
systemctl --user restart gemini-canvas-proxy.service
```

---

## Browser Automation & Navigation Guide (Lessons Learned)

When building or customizing extension-level browser navigation automation for Gemini Canvas Proxy (in `extension/content_script.js`), follow these critical architectural findings:

### 1. Boot to Base URL (`https://gemini.google.com/app`)
* **Do NOT set `START_PAGE` directly to a specific chat URL** (`https://gemini.google.com/app/<chat-id>`).
* Gemini's Angular SPA client-side router will render the blank home screen ("What can I help with?") on startup even if the URL bar shows the chat thread ID.
* Always boot to the base URL `https://gemini.google.com/app` and let `content_script.js` perform an in-page click on the target thread link to trigger Angular's state router into fetching conversation data.

### 2. Bypass Angular Event Suppression (`dispatchFullClick`)
Standard JavaScript `.click()` events are often suppressed or ignored by modern Web Components and Angular router elements.
Always dispatch a full synthetic mouse event sequence:

```javascript
function dispatchFullClick(el) {
    if (!el) return;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventType => {
        el.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
    });
}
```

### 3. Enforce DOM Visibility Checks (`isVisible`)
Gemini's DOM keeps hidden `<a>` elements for recents inside collapsed drawer menus. Standard `document.querySelectorAll('a')` queries will match hidden elements and fire clicks on invisible nodes that Angular ignores, trapping the automation in a false-positive loop.
Always guard element selection with an `isVisible()` helper:

```javascript
function isVisible(el) {
    if (!el) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}
```

### 4. Narrow `activeElement` Guard Scope
On page load, Gemini automatically focuses its main prompt box (`+ Ask Gemini`), causing `document.activeElement` to be a `<textarea>`, `<input>`, or `[contenteditable="true"]` form element.
Broad active-element checks (`if (active.isContentEditable) return;`) will cause the script to abort indefinitely.
Limit `activeElement` guards strictly to active code editing in Monaco:

```javascript
const active = document.activeElement;
if (active && active.closest('.monaco-editor, .code-editor')) {
    return; // Don't interrupt user while editing code in Canvas
}
```

### 5. Resilient 4-Step Prioritized Flow
To prevent unnecessary sidebar toggling, order automation actions from highest-granularity to lowest:

1. **Step 1 (Preview Tab)**: Check if Canvas `Preview` tab is visible & unselected $\rightarrow$ Click if found.
2. **Step 2 (Canvas Card)**: Search for visible target Canvas Card (`Hi Webapp`) on screen $\rightarrow$ Click if found (bypasses sidebar navigation if already in chat).
3. **Step 3 (Chat Link)**: Search for visible chat thread link (`Minimal HTML Web App Creation` or thread ID) in sidebar $\rightarrow$ Click if found.
4. **Step 4 (Sidebar Expansion)**: Only if no chat link or card is currently visible $\rightarrow$ Click visible sidebar toggle (`button[aria-label="Open sidebar"]` / `[aria-label*="menu"]`).

