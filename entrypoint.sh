#!/usr/bin/env bash

# Automatically drop privileges to "proxy" user if run as root inside container
if [ "$(id -u)" -eq 0 ] && id "proxy" >/dev/null 2>&1; then
    # Enterprise policy (root-only path): disable browser-level Google sign-in /
    # account consistency. Without this, Dice AccountReconcilor sees CookieJar
    # accounts but Chrome 0 token accounts and runs PerformLogoutAllAccountsAction,
    # wiping Google cookies on every restart even when OSCrypt/keyring works.
    mkdir -p /etc/chromium/policies/managed /etc/chromium/policies/recommended
    cat > /etc/chromium/policies/managed/gemini-proxy-signin.json <<'POLICY'
{
  "BrowserSignin": 0,
  "SyncDisabled": true
}
POLICY
    exec gosu proxy "$0" "$@"
fi

# Override HOME to writable browser-data directory to prevent read-only filesystem crashes
export HOME=/browser-data/home
mkdir -p "$HOME"

# ──────────────────────────────────────────────────────────────────────────────
# Gemini Canvas Proxy — Container Entrypoint
# ──────────────────────────────────────────────────────────────────────────────
# Expects /browser-data to be chown'd to "proxy" — handled by preflight.sh as
# root before this script executes.
# ──────────────────────────────────────────────────────────────────────────────

DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
PROXY_PORT="${PROXY_PORT:-8765}"
CHROMIUM_USER_DATA_DIR="${CHROMIUM_USER_DATA_DIR:-/browser-data/chromium-profile}"
START_PAGE="${START_PAGE:-https://gemini.google.com/app}"
NATIVE_HOST_DIR="${NATIVE_HOST_DIR:-/browser-data/chromium-profile/NativeMessagingHosts}"

# Preflight: Ensure Chromium user-data-dir and native messaging manifest dirs
# exist under the proxy user's scope.
mkdir -p "$CHROMIUM_USER_DATA_DIR" "$NATIVE_HOST_DIR"

# Preflight: Copy chrome native messaging host manifest template if it doesn't
# already exist. The setup-extension.sh step modifies this with the real extension ID.
if [ ! -f "$NATIVE_HOST_DIR/com.gemini.proxy.json" ]; then
    echo "[entrypoint] Initializing native messaging host manifest"
    mkdir -p /tmp/manifest
    cat << 'EOF' > "$NATIVE_HOST_DIR/com.gemini.proxy.json"
{
  "name": "com.gemini.proxy",
  "description": "Gemini Canvas Proxy native messaging helper",
  "path": "/app/native_host/gemini_proxy.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://edoicfpldmlabgdalemfgflpldiijdmm/"
  ]
}
EOF
fi

# Preflight: Chromium requires a machine-id for dbus/keyring to work. Ensure
# /etc/machine-id exists and is persistent. If not, generate a local fallback
# so the keyring daemon doesn't throw D-Bus init errors.
if [ ! -f /etc/machine-id ] && [ ! -f /var/lib/dbus/machine-id ]; then
    echo "[entrypoint] Generating fallback machine-id"
    dbus-uuidgen --ensure
fi

# ── Boot-critical env (cookie OSCrypt via gnome-libsecret) ───────────────────
# Community consensus (Arch BBS cookie-loss-on-reboot, Manjaro keyring races,
# Docker/headless keyring guides, Chromium 116+ gnome→gnome-libsecret):
# Chromium must not start until Secret Service is on the session bus and the
# login keyring is unlocked. Otherwise OSCrypt cannot read "Chromium Safe
# Storage", cookies are undecryptable, and Google looks logged out.
# Keep --password-store=gnome-libsecret only (basic/mock-keychain never persisted).
export DISPLAY=":${DISPLAY_NUM}"
export HOME="/browser-data/home"
mkdir -p "$HOME" "$HOME/.local/share/keyrings"

# ── 1. Xvfb first (keyring/libsecret clients often expect a live DISPLAY) ───
echo "[entrypoint] Starting Xvfb on :$DISPLAY_NUM"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
Xvfb ":$DISPLAY_NUM" -screen 0 1280x720x24 -nolisten tcp -nolisten unix &
XVFB_PID=$!
sleep 1

for _ in $(seq 1 30); do
    if xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

if ! xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1; then
    echo "[entrypoint] FATAL: Xvfb failed to start on :$DISPLAY_NUM" >&2
    exit 1
fi

# ── 2. Openbox ────────────────────────────────────────────────────────────────
echo "[entrypoint] Starting Openbox"
openbox &
OPENBOX_PID=$!

# ── 3. D-Bus session + GNOME Keyring (after X is up) ─────────────────────────
echo "[entrypoint] Starting D-Bus session daemon (fixed socket)"
rm -f /tmp/dbus-session.sock 2>/dev/null || true
if [ -f /usr/share/dbus-1/session.conf ]; then
    dbus-daemon --config-file=/usr/share/dbus-1/session.conf \
        --address=unix:path=/tmp/dbus-session.sock --fork \
        >/tmp/dbus-start.log 2>&1 || true
fi
if [ -S /tmp/dbus-session.sock ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus-session.sock"
else
    echo "[entrypoint] Fixed socket missing; falling back to dbus-launch" >&2
    eval "$(dbus-launch --sh-syntax)"
fi
# Let the bus settle before keyring registers names
sleep 0.5
printf '%s\n' "$DBUS_SESSION_BUS_ADDRESS" > /tmp/gemini-dbus-address
echo "[entrypoint] DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"

if command -v gnome-keyring-daemon >/dev/null 2>&1; then
    echo "[entrypoint] Starting GNOME Keyring (unlock + secrets)"
    # Proven headless sequence: unlock with password, then start secrets component.
    # Do not spawn a second bare --unlock (leaves a stray daemon).
    eval "$(echo -n "peanuts" | gnome-keyring-daemon --replace --unlock)" || true
    eval "$(gnome-keyring-daemon --start --components=secrets)" || true
    export GNOME_KEYRING_CONTROL
    export SSH_AUTH_SOCK
fi

wait_for_secret_service() {
    local i locked owner
    echo "[entrypoint] Waiting for org.freedesktop.secrets + unlocked login keyring..."
    for i in $(seq 1 90); do
        # dbus-send prints e.g. "   boolean true" or "   variant       boolean false"
        # Use $NF so we get true/false, not the word "boolean".
        owner=$(dbus-send --session --dest=org.freedesktop.DBus --print-reply \
            /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
            string:org.freedesktop.secrets 2>/dev/null \
            | awk '/boolean/{print $NF; exit}' || true)
        if [ "$owner" != "true" ]; then
            if [ $((i % 10)) -eq 0 ]; then
                echo "[entrypoint] ... secrets name not owned yet (try $i/90, owner=${owner:-?})"
            fi
            sleep 0.2
            continue
        fi
        locked=$(dbus-send --session --dest=org.freedesktop.secrets --print-reply \
            /org/freedesktop/secrets/collection/login \
            org.freedesktop.DBus.Properties.Get \
            string:org.freedesktop.Secret.Collection string:Locked 2>/dev/null \
            | awk '/boolean/{print $NF; exit}' || true)
        if [ "$locked" = "false" ]; then
            echo "[entrypoint] Secret Service ready (login unlocked) after try $i"
            return 0
        fi
        if [ $((i % 10)) -eq 0 ]; then
            echo "[entrypoint] ... secrets owned but login locked=${locked:-?} (try $i/90)"
        fi
        # Re-nudge unlock if still locked
        if [ "$locked" = "true" ] && [ $((i % 20)) -eq 0 ]; then
            echo "[entrypoint] re-unlocking login keyring..."
            echo -n "peanuts" | gnome-keyring-daemon --start --components=secrets 2>/dev/null || true
            eval "$(echo -n "peanuts" | gnome-keyring-daemon --replace --unlock)" 2>/dev/null || true
        fi
        sleep 0.2
    done
    echo "[entrypoint] WARNING: Secret Service not confirmed after ~18s; cookies may not load" >&2
    return 0
}
wait_for_secret_service
# Settle so Chromium OSCrypt does not race libsecret init
sleep 1

# ── 4. Chromium ──────────────────────────────────────────────────────────────
# Explicit env: OSCrypt/libsecret needs DBUS at process init.
# (Chromium may later scrub /proc/environ; that is normal.)
#
# Also force signin.allowed=false in Preferences while browser is stopped so
# AccountConsistencyMethod becomes kDisabled even if policy path is missing.
# That stops AccountReconcilor from logging out cookie-only Google sessions.
if [ -f "$CHROMIUM_USER_DATA_DIR/Default/Preferences" ]; then
    python3 - <<'PY' || true
import json, os
path = "/browser-data/chromium-profile/Default/Preferences"
with open(path, "r", encoding="utf-8") as f:
    p = json.load(f)
p.setdefault("signin", {})["allowed"] = False
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(p, f, separators=(",", ":"), ensure_ascii=False)
os.replace(tmp, path)
print("[entrypoint] Preferences: signin.allowed=false (block reconcilor logout)")
PY
fi

echo "[entrypoint] Starting Chromium (profile: $CHROMIUM_USER_DATA_DIR)"
echo "[entrypoint] env HOME=$HOME DBUS=$DBUS_SESSION_BUS_ADDRESS DISPLAY=$DISPLAY password-store=gnome-libsecret"
if [ -f /etc/chromium/policies/managed/gemini-proxy-signin.json ]; then
    echo "[entrypoint] managed policy: $(cat /etc/chromium/policies/managed/gemini-proxy-signin.json)"
fi
rm -f "$CHROMIUM_USER_DATA_DIR"/Singleton*
env \
    HOME="$HOME" \
    DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
    DISPLAY="$DISPLAY" \
    GNOME_KEYRING_CONTROL="${GNOME_KEYRING_CONTROL:-}" \
    chromium \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --window-size=1280,720 \
    --no-first-run \
    --disable-session-crashed-bubble \
    --noerrdialogs \
    --renderer-process-limit=1 \
    --js-flags="--max-old-space-size=768" \
    --disk-cache-size=10485760 \
    --media-cache-size=10485760 \
    --prerender-from-omnibox=disabled \
    --user-data-dir="$CHROMIUM_USER_DATA_DIR" \
    --password-store=gnome-libsecret \
    --account-consistency=disabled \
    --load-extension=/app/extension \
    --enable-logging=stderr \
    --v=1 \
    "$START_PAGE" \
    >/tmp/chromium.log 2>&1 &
CHROMIUM_PID=$!

# ── 3.5. Keyring Watchdog Daemon ─────────────────────────────────────────────
# Automatically unlocks the keyring dialog if it appears on screen
# Auto-dismiss intermittent "Unlock Login Keyring" / "Unlock" dialogs (type peanuts)
if command -v xdotool >/dev/null 2>&1; then
    echo "[entrypoint] Starting Keyring Watchdog Daemon (xdotool)"
    (
        while true; do
            # Broad match: titles vary ("Unlock Login Keyring", "Unlock Keyring", "Unlock")
            WID=$(xdotool search --onlyvisible --name 'Unlock' 2>/dev/null | head -n 1)
            if [ -z "$WID" ]; then
                WID=$(xdotool search --onlyvisible --name 'Keyring' 2>/dev/null | head -n 1)
            fi
            if [ -n "$WID" ]; then
                echo "[watchdog] Keyring dialog window=$WID — typing peanuts"
                xdotool windowactivate --sync "$WID" 2>/dev/null || true
                sleep 0.2
                xdotool type --delay 50 "peanuts"
                xdotool key "Return"
                sleep 5
            fi
            sleep 2
        done
    ) &
    WATCHDOG_PID=$!
else
    echo "[entrypoint] xdotool not found. Keyring Watchdog is disabled (install xdotool in image)."
    WATCHDOG_PID=""
fi

# ── 4. x11vnc ─────────────────────────────────────────────────────────────────
echo "[entrypoint] Starting x11vnc on :$VNC_PORT"
x11vnc -display ":$DISPLAY_NUM"     -nopw     -forever     -shared     -xkb     -rfbport "$VNC_PORT"     >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!

# ── 5. websockify + noVNC ────────────────────────────────────────────────────
echo "[entrypoint] Starting websockify + noVNC on :$NOVNC_PORT"
NOVNC_WEB="${NOVNC_WEB:-/usr/share/novnc}"
websockify --web="$NOVNC_WEB" "$NOVNC_PORT" "localhost:$VNC_PORT"     >/tmp/websockify.log 2>&1 &
WEBSOCKIFY_PID=$!

# ── 5.5. VNC Auto-Shutdown Timer ─────────────────────────────────────────────
# Automatically shuts down VNC and websockify after 3 minutes to save memory
(
    echo "[entrypoint] VNC is active. Starting 3-minute auto-shutdown countdown..."
    sleep 180
    echo "[entrypoint] Auto-stopping VNC and websockify to reclaim memory..."
    /app/toggle-vnc.sh stop
) &

# ── 6. Proxy ──────────────────────────────────────────────────────────────────
echo "[entrypoint] Native messaging host will start via Chromium extension"

# ── Trap for clean shutdown ──────────────────────────────────────────────────
shutdown() {
    echo "[entrypoint] Shutting down — waiting for Chromium to sync..."
    pkill -TERM -f chromium 2>/dev/null || true
    for _ in $(seq 1 80); do
        if ! pgrep -f chromium >/dev/null; then
            echo "[entrypoint] Chromium exited cleanly."
            break
        fi
        sleep 0.1
    done
    kill -TERM "$PROXY_PID" "$WEBSOCKIFY_PID" "$X11VNC_PID"         "$OPENBOX_PID" "$XVFB_PID" "$TAIL_PID" "$WATCHDOG_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    exit 0
}
trap shutdown INT TERM

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Gemini Canvas Proxy — full stack running"
echo "═══════════════════════════════════════════════════════════════"
echo "  noVNC web UI:   http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=true&resize=scale"
echo "  Proxy HTTP API: http://127.0.0.1:$PROXY_PORT/v1/models"
echo "  Native messaging manifest dir: $NATIVE_HOST_DIR"
echo "═══════════════════════════════════════════════════════════════"
echo ""

tail -F /tmp/proxy.log &
TAIL_PID=$!
wait $TAIL_PID

