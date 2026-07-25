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
