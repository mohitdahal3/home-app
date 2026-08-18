# Cloudflare Tunnel Setup for Home Server (Ubuntu)

This guide walks you through installing `cloudflared`, creating a tunnel, and
running it as a persistent systemd service so your WebSocket server is
accessible from the internet even when your laptop changes networks.

---

## Prerequisites

- A free Cloudflare account at [dash.cloudflare.com](https://dash.cloudflare.com)
- A domain added to Cloudflare (even a cheap one works — you just need DNS managed by CF)
- Your Home server running on `ws://localhost:8080`

---

## Step 1 — Install cloudflared

```bash
# Download the latest .deb package
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb

# Install it
sudo dpkg -i cloudflared.deb

# Clean up
rm cloudflared.deb

# Verify
cloudflared --version
```

---

## Step 2 — Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens your browser. Log in to Cloudflare and **select the domain** you want
to use. A certificate is saved to `~/.cloudflared/cert.pem`.

---

## Step 3 — Create a Named Tunnel

```bash
cloudflared tunnel create home-server
```

This outputs a **Tunnel UUID** (e.g., `a1b2c3d4-...`). Note it down.

It also creates a credentials file at:
`~/.cloudflared/<TUNNEL-UUID>.json`

---

## Step 4 — Configure the Tunnel

Create the config file:

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Paste this (replace the placeholders):

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /home/<YOUR-USERNAME>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: home.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

> **Note:** Even though your server uses WebSockets, Cloudflare Tunnel proxies
> `ws://` connections over `http://` automatically. Use `http://localhost:8080`.

---

## Step 5 — Create DNS Route

```bash
cloudflared tunnel route dns home-server home.yourdomain.com
```

This creates a CNAME record pointing `home.yourdomain.com` → your tunnel.

---

## Step 6 — Test the Tunnel Manually

```bash
cloudflared tunnel run home-server
```

Your server should now be reachable at `wss://home.yourdomain.com`. Test with:

```bash
# In another terminal
npx -y wscat -c wss://home.yourdomain.com
```

Press `Ctrl+C` to stop the manual tunnel once confirmed working.

---

## Step 7 — Install as a systemd Service

This makes the tunnel start automatically on boot and survive reboots/crashes.

```bash
sudo cloudflared service install
```

This copies your config into `/etc/cloudflared/` and creates a systemd unit.

Then enable and start it:

```bash
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

Verify it's running:

```bash
sudo systemctl status cloudflared
```

You should see `Active: active (running)`.

---

## Step 8 — (Optional) Also Run the Node Server as a systemd Service

Create a service file so the Node.js server starts on boot too:

```bash
sudo nano /etc/systemd/system/home-server.service
```

Paste this (update the paths for your system):

```ini
[Unit]
Description=Home Grocery List WebSocket Server
After=network.target

[Service]
Type=simple
User=<YOUR-USERNAME>
WorkingDirectory=/home/<YOUR-USERNAME>/Projects/Home App Root/server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable home-server
sudo systemctl start home-server
sudo systemctl status home-server
```

---

## Useful Commands

| Command | What it does |
|---|---|
| `sudo systemctl status cloudflared` | Check tunnel status |
| `sudo systemctl restart cloudflared` | Restart tunnel |
| `sudo systemctl status home-server` | Check Node server status |
| `journalctl -u cloudflared -f` | Tail tunnel logs |
| `journalctl -u home-server -f` | Tail server logs |
| `cloudflared tunnel list` | List all your tunnels |
| `cloudflared tunnel info home-server` | Tunnel details |

---

## Your App's Connection URL

Once everything is running, your React Native app connects to:

```
wss://home.yourdomain.com
```

Cloudflare handles TLS automatically — no cert management needed on your end.
