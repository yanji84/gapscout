#!/bin/bash
set -euo pipefail

echo "=== GapScout Deployment Setup ==="

# Ensure data directory
mkdir -p /root/gapscout/data/scans

# Install server deps if needed
cd /root/gapscout/server
if [ ! -d node_modules ]; then
    npm ci --production
fi
cd /root/gapscout

# Install systemd service
cp deploy/gapscout.service /etc/systemd/system/gapscout.service
systemctl daemon-reload
systemctl enable gapscout
systemctl restart gapscout

echo "Waiting for service to start..."
sleep 3

if systemctl is-active --quiet gapscout; then
    echo "GapScout service is running on port 3002"
else
    echo "ERROR: Service failed to start"
    journalctl -u gapscout --no-pager -n 20
    exit 1
fi

# Add GapScout route to Caddy
CADDY_MARKER="# --- GapScout ---"
if grep -q "$CADDY_MARKER" /etc/caddy/Caddyfile; then
    echo "GapScout Caddy config already present, skipping..."
else
    echo "Adding GapScout to Caddy config..."
    sed -i "/reverse_proxy localhost:3000/i\\
\\t${CADDY_MARKER}\\n\\tredir /gapscout /gapscout/ 308\\n\\n\\thandle_path /gapscout/* {\\n\\t\\treverse_proxy 127.0.0.1:3002 {\\n\\t\\t\\tflush_interval -1\\n\\t\\t}\\n\\t}\\n" /etc/caddy/Caddyfile

    if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
        systemctl reload caddy
        echo "Caddy reloaded with GapScout route"
    else
        echo "ERROR: Caddy config validation failed"
        exit 1
    fi
fi

echo ""
echo "=== Deployment Complete ==="
echo "GapScout is available at: https://ggbot.it.com/gapscout/"
echo ""
echo "Commands:"
echo "  systemctl status gapscout     # Check status"
echo "  journalctl -u gapscout -f     # Follow logs"
echo "  systemctl restart gapscout    # Restart"
