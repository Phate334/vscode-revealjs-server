#!/usr/bin/env bash
# Live smoke against compose-published port (AGENTS: no host uvicorn for live checks).
# Covers: health, project create, preview HTML, runtime static, binary asset via preview,
# chapter-relative asset rewrite. CRDT unsaved-edit visibility: real VS Code EDH only.
set -euo pipefail
BASE="${1:-http://127.0.0.1:8000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_PROJECTS="${ROOT}/.data/projects"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "=== compose smoke @ ${BASE} ==="

echo "GET ${BASE}/health"
HEALTH="$(curl -sfS "${BASE}/health")" || fail "health"
echo "${HEALTH}" | grep -q '"status":"ok"' || fail "health body: ${HEALTH}"
pass "health"

NAME="smoke-$(date +%s)"
echo "POST /api/projects name=${NAME}"
CREATE="$(curl -sfS -X POST "${BASE}/api/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"${NAME}\"}")" || fail "create project"
PID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${CREATE}")"
[[ -n "${PID}" ]] || fail "no project id in ${CREATE}"
pass "create project ${PID}"

echo "GET /p/${PID}/preview"
PREV="$(curl -sfS "${BASE}/p/${PID}/preview")" || fail "preview HTML"
echo "${PREV}" | grep -q 'reveal.js' || fail "preview missing reveal.js"
echo "${PREV}" | grep -q 'data-markdown=' || fail "preview missing slides"
echo "${PREV}" | grep -q "/runtimes/reveal-v1/" || fail "preview missing runtime urls"
if echo "${PREV}" | grep -q 'PRESENTATION_RUNTIME_CSS\|PRESENTATION_SLIDES\|PRESENTATION_RUNTIME_JS'; then
  fail "injection markers left unreplaced"
fi
pass "preview HTML injected"

echo "GET /runtimes/reveal-v1/reveal.js"
curl -sfS -o /dev/null "${BASE}/runtimes/reveal-v1/reveal.js" || fail "runtime reveal.js"
pass "runtime static reveal.js"

echo "GET /runtimes/not-a-runtime/reveal.js → 404"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/runtimes/not-a-runtime/reveal.js" || true)"
[[ "${CODE}" == "404" ]] || fail "expected 404 for unknown runtime, got ${CODE}"
pass "unknown runtime 404"

# Client URL normalizers collapse /runtimes/../…; assert registry reject for odd names.
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/runtimes/..evil../reveal.js" || true)"
[[ "${CODE}" == "404" ]] || fail "expected 404 for non-registry runtime_name, got ${CODE}"
pass "non-registry runtime_name 404"

PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
ASSET_PATH='01-introduction/hero.png'
echo "PUT /api/projects/${PID}/assets/${ASSET_PATH}"
echo "${PNG_B64}" | base64 -d | curl -sfS -X PUT \
  "${BASE}/api/projects/${PID}/assets/${ASSET_PATH}" \
  --data-binary @- -H 'Content-Type: application/octet-stream' >/dev/null \
  || fail "put asset"
pass "put binary asset"

echo "GET preview asset /p/${PID}/preview/${ASSET_PATH}"
curl -sfS -o /tmp/smoke-hero.png "${BASE}/p/${PID}/preview/${ASSET_PATH}" || fail "preview asset"
python3 -c 'import pathlib; b=pathlib.Path("/tmp/smoke-hero.png").read_bytes(); assert b[:8]==b"\x89PNG\r\n\x1a\n", b[:16]' \
  || fail "preview asset not PNG"
pass "preview binary asset"

# Rewrite check uses a non-CRDT-bound chapter path (disk text).
# Bound slide (01-introduction/slide.md) prefers live CRDT — unsaved edits: VS Code EDH.
EXTRA_DIR="${DATA_PROJECTS}/${PID}/workspace/02-extra"
if [[ -d "${DATA_PROJECTS}/${PID}/workspace" ]]; then
  sudo mkdir -p "${EXTRA_DIR}"
  sudo tee "${EXTRA_DIR}/slide.md" >/dev/null <<MD
# Extra

![hero](hero.png)

<img src="hero.png" alt="h" />
MD
  echo "${PNG_B64}" | base64 -d | curl -sfS -X PUT \
    "${BASE}/api/projects/${PID}/assets/02-extra/hero.png" \
    --data-binary @- -H 'Content-Type: application/octet-stream' >/dev/null \
    || fail "put 02-extra asset"
  MD_OUT="$(curl -sfS "${BASE}/p/${PID}/preview/02-extra/slide.md")" || fail "get 02-extra md"
  echo "${MD_OUT}" | grep -q "/p/${PID}/preview/02-extra/hero.png" \
    || fail "chapter-relative rewrite missing: ${MD_OUT}"
  pass "chapter-relative asset rewrite"
else
  echo "SKIP: chapter rewrite (no host workspace mount)"
fi

echo "=== all compose smoke checks passed ==="
