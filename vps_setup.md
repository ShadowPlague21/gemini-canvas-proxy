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

## 3. Interactive Setup (Tailscale + VNC)
Because Gemini Canvas requires a Google login and manual extension loading, you need a way to interact with the browser once. We use **Xvfb** + **x11vnc** over Tailscale for this.

1. Install interaction tools on the VPS:
   ```bash
   sudo apt update
   sudo apt install -y x11vnc xvfb fluxbox
   ```

2. Start the virtual desktop and VNC server:
   ```bash
   # Start virtual display
   Xvfb :99 -screen 0 1280x720x16 &
   export DISPLAY=:99
   
   # Start a tiny window manager
   fluxbox &
   
   # Start VNC server bound to all interfaces (accessible via Tailscale)
   x11vnc -display :99 -nopw -forever -xkb
   ```

3. Connect from your local laptop:
   Open any VNC client (RealVNC, TigerVNC, or macOS Screen Sharing) and connect to:
   `<vps-tailscale-ip>:5900`

4. **In the VNC Window:**
   - Open Chromium: `chromium-browser --user-data-dir=$HOME/.config/chromium-vps`
   - Log in to [gemini.google.com](https://gemini.google.com).
   - Go to `chrome://extensions`, enable **Developer Mode**, and **Load Unpacked** the `extension/` folder.
   - **Copy the Extension ID** and start a Canvas session.

## 4. Final Proxy Setup
Once you have the Extension ID, run the setup script on the VPS:
```bash
./setup.sh  # Paste the ID when prompted
```

## 5. Headless Production Mode
After the initial setup is done, you don't need VNC anymore. You can run Chromium and the proxy in the background:

```bash
xvfb-run --server-args="-screen 0 1280x800x24" \
  chromium-browser --user-data-dir=$HOME/.config/chromium-vps
```

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
