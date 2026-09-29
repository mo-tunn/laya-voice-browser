#!/usr/bin/env bash
# Launch the voice-browser server. The Node process auto-starts local Laya from .venv.
# Usage: ./run.sh [--port 8787] [--host 127.0.0.1] [--headless] [--cdp ws://...] [--start-url https://...]
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; fi

exec node src/start.js "$@"
