#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Gemini Canvas Proxy — VNC Toggle Script
# ──────────────────────────────────────────────────────────────────────────────
# Usage:
#   /app/toggle-vnc.sh start  -> Start x11vnc and noVNC (for logging in / setup)
#   /app/toggle-vnc.sh stop   -> Stop x11vnc and noVNC (saves CPU/RAM during normal use)
#   /app/toggle-vnc.sh status -> Show whether x11vnc / websockify are running
#
# Note: podman/docker exec defaults to root. x11vnc must run as the same user
# that owns Xvfb (proxy), otherwise MIT-SHM attach fails. This script re-execs
# as proxy via gosu when invoked as root.
# ──────────────────────────────────────────────────────────────────────────────

# Privilege rules (podman exec defaults to root):
#   start  → must run as proxy (same user as Xvfb; root hits MIT-SHM BadAccess)
#   stop   → stay root so we can kill processes started under either uid
#   status → either uid is fine
if [ "$(id -u)" -eq 0 ] && id "proxy" >/dev/null 2>&1; then
    case "$1" in
        start)
            export DISPLAY="${DISPLAY:-:99}"
            exec gosu proxy "$0" "$@"
            ;;
    esac
fi

DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
NOVNC_WEB="${NOVNC_WEB:-/usr/share/novnc}"

stop_vnc() {
    echo "[VNC Toggle] Stopping x11vnc and websockify..."

    # Find and kill x11vnc
    pkill -f "x11vnc" || true
    # Find and kill websockify
    pkill -f "websockify" || true

    echo "[VNC Toggle] VNC server stopped. Idle CPU and RAM resources saved."
}

start_vnc() {
    # Check if x11vnc is already running
    if pgrep -f "x11vnc" >/dev/null; then
        echo "[VNC Toggle] x11vnc is already running."
    else
        echo "[VNC Toggle] Starting x11vnc on display :$DISPLAY_NUM, port $VNC_PORT..."
        # Use /dev/null — avoid permission issues writing /tmp/*.log from some contexts
        x11vnc -display ":$DISPLAY_NUM" \
            -nopw \
            -forever \
            -shared \
            -xkb \
            -rfbport "$VNC_PORT" \
            >/dev/null 2>&1 &
        sleep 0.5
        if ! pgrep -f "x11vnc" >/dev/null; then
            echo "[VNC Toggle] WARNING: x11vnc failed to stay up. Retrying with -noshm..."
            x11vnc -display ":$DISPLAY_NUM" \
                -nopw \
                -forever \
                -shared \
                -xkb \
                -noshm \
                -rfbport "$VNC_PORT" \
                >/dev/null 2>&1 &
            sleep 0.5
            if ! pgrep -f "x11vnc" >/dev/null; then
                echo "[VNC Toggle] ERROR: x11vnc failed to start." >&2
            fi
        fi
    fi

    # Check if websockify is already running
    if pgrep -f "websockify" >/dev/null; then
        echo "[VNC Toggle] websockify is already running."
    else
        echo "[VNC Toggle] Starting websockify on port $NOVNC_PORT..."
        websockify --web="$NOVNC_WEB" "$NOVNC_PORT" "localhost:$VNC_PORT" \
            >/dev/null 2>&1 &
        sleep 0.3
        if ! pgrep -f "websockify" >/dev/null; then
            echo "[VNC Toggle] ERROR: websockify failed to start." >&2
        fi
    fi

    echo "[VNC Toggle] VNC server running. Access via: http://<PC2_IP>:$NOVNC_PORT/vnc.html"
}

status_vnc() {
    x11_status="OFFLINE"
    web_status="OFFLINE"

    if pgrep -f "x11vnc" >/dev/null; then x11_status="RUNNING"; fi
    if pgrep -f "websockify" >/dev/null; then web_status="RUNNING"; fi

    echo "[VNC Toggle] Status:"
    echo "  x11vnc (VNC Server): $x11_status"
    echo "  websockify (noVNC):  $web_status"
}

case "$1" in
    start)
        start_vnc
        ;;
    stop)
        stop_vnc
        ;;
    status)
        status_vnc
        ;;
    *)
        echo "Usage: $0 {start|stop|status}"
        exit 1
        ;;
esac
