#!/bin/bash
# Stop the Gemini Canvas Proxy native host process
# Kills any running instance and cleans up

echo "Stopping Gemini Canvas Proxy..."

# Find and kill the native host process
PIDS=$(pgrep -f "gemini_proxy.py" 2>/dev/null)

if [ -z "$PIDS" ]; then
    echo "  No running proxy process found."
else
    for PID in $PIDS; do
        echo "  Killing PID $PID..."
        kill "$PID" 2>/dev/null
    done
    sleep 1
    # Force kill if still alive
    for PID in $PIDS; do
        if kill -0 "$PID" 2>/dev/null; then
            echo "  Force killing PID $PID..."
            kill -9 "$PID" 2>/dev/null
        fi
    done
    echo "  Proxy stopped."
fi

# Verify port 8765 is free
if command -v ss &>/dev/null; then
    if ss -tlnp | grep -q ":8765"; then
        echo "  WARNING: Port 8765 still in use by another process."
    else
        echo "  Port 8765 is free."
    fi
fi

echo "Done."
