# ☁️ Running on a VPS with Tailscale

Deploying to a VPS allows for a **24/7 "set it and forget it" private API**. Since Tailscale creates a secure mesh network, your proxy stays private (bound to `localhost`) but remains accessible from any of your devices on the tailnet.

## Prerequisites
- A Linux VPS (Ubuntu 22.04+ recommended, 2GB+ RAM)
- [Tailscale](https://tailscale.com/) account
- A Chromium-based browser (Chrome or Chromium)

## 1. Initial Setup
Install Tailscale and the browser dependencies on your VPS:
```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Install Chromium and Xvfb (for headless display)
sudo apt update
sudo apt install -y chromium-browser xvfb
```

## 2. Setup the Proxy
Clone the repo and run the setup script:
```bash
git clone https://github.com/pranrichh/gemini-canvas-proxy.git
cd gemini-canvas-proxy
chmod +x setup.sh
./setup.sh  # Follow prompts for Extension ID
```

## 3. Interactive Setup (Web-based VNC)
The easiest way to interact with the VPS browser is through **noVNC**. This lets you see and control the VPS desktop directly in your local browser (no VNC client needed).

1. Install the tools on the VPS:
   ```bash
   sudo apt update
   sudo apt install -y x11vnc xvfb fluxbox novnc websockify
   ```

2. Start the desktop and web-VNC proxy:
   ```bash
   # 1. Start virtual display
   Xvfb :99 -screen 0 1280x720x16 &
   export DISPLAY=:99
   
   # 2. Start a tiny window manager
   fluxbox &
   
   # 3. Start VNC server
   x11vnc -display :99 -nopw -forever -xkb &
   
   # 4. Start the Web-to-VNC proxy (Port 6080)
   websockify --web /usr/share/novnc/ 6080 localhost:5900 &
   ```

3. **In your local browser**, navigate to:
   `http://<vps-tailscale-ip>:6080/vnc.html?autoconnect=true`

4. **In the Web Window:**
   - You will see the VPS desktop. Right-click anywhere and select **Applications -> Shells -> Bash** (or just run from your SSH terminal).
   - Launch Chromium: `chromium-browser --user-data-dir=$HOME/.config/chromium-vps`
   - Log in to [gemini.google.com](https://gemini.google.com).
   - Go to `chrome://extensions`, enable **Developer Mode**, and **Load Unpacked** the `extension/` folder.
   - **Copy the Extension ID** and start a Canvas session.

## 4. Final Proxy Setup
Once you have the Extension ID, run the setup script on the VPS:
```bash
./setup.sh  # Paste the ID when prompted
```

## 5. Headless Production Mode
After you've logged in and loaded the extension, the browser profile is saved. You can now kill the VNC/noVNC processes and run Chromium 24/7 headlessly:

```bash
# Start Chromium headlessly (saved in your tmux/screen session)
xvfb-run --server-args="-screen 0 1280x800x24" \
  chromium-browser --user-data-dir=$HOME/.config/chromium-vps
```

## 6. Access via Tailscale

## 6. Access via Tailscale
The proxy now defaults to binding to `0.0.0.0:8765`, meaning it is reachable from any interface.

**Private Access (Recommended)**
If you are running Tailscale on the VPS, the proxy is automatically reachable at:
`http://<vps-tailscale-ip>:8765/v1`

**Tailscale Funnel (Alternative)**
If you want to keep the proxy bound specifically to a single interface or use Tailscale's built-in relaying:
```bash
tailscale serve 8765
```

---
**Tip:** Use a `systemd` unit or `screen`/`tmux` to keep the `xvfb-run` session alive 24/7.
