#!/usr/bin/env bash
# Runs the API server and an ngrok tunnel together for local Telnyx testing.
# Usage: ./dev-with-tunnel.sh
set -euo pipefail

if ! command -v ngrok &> /dev/null; then
  echo "ngrok not found. Install it first: https://ngrok.com/download" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo ".env not found. Run: cp .env.example .env and fill in the required values first." >&2
  exit 1
fi

cleanup() {
  echo "Shutting down..."
  kill "$API_PID" "$NGROK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting API server..."
npm run dev:api &
API_PID=$!

echo "Waiting for API on port 3000..."
until curl -sf http://localhost:3000 -o /dev/null 2>/dev/null || ! kill -0 "$API_PID" 2>/dev/null; do
  sleep 1
done

echo "Starting ngrok tunnel..."
ngrok http 3000 --log stdout > /tmp/ngrok.log &
NGROK_PID=$!

sleep 3
PUBLIC_URL=$(curl -s http://127.0.0.1:4040/api/tunnels | grep -o '"public_url":"https:[^"]*' | head -1 | cut -d'"' -f4)

if [ -z "$PUBLIC_URL" ]; then
  echo "Could not detect ngrok URL. Check http://127.0.0.1:4040 or /tmp/ngrok.log" >&2
else
  echo ""
  echo "=================================================================="
  echo "Public URL:      $PUBLIC_URL"
  echo "Webhook URL:     $PUBLIC_URL/api/calls/webhook"
  echo "Media stream WS: $(echo "$PUBLIC_URL" | sed 's/^https/wss/')"
  echo "=================================================================="
  echo "1. Set the Webhook URL above in your Telnyx Voice API Application"
  echo "2. Set BASE_URL=$PUBLIC_URL in your .env, then restart this script"
  echo "=================================================================="
  echo ""
fi

wait
