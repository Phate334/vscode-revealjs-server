#!/usr/bin/env bash
# Live smoke against compose-published port (AGENTS: no host uvicorn for live checks).
set -euo pipefail
BASE="${1:-http://127.0.0.1:8000}"
echo "GET ${BASE}/health"
curl -sfS "${BASE}/health"
echo
