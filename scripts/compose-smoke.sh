#!/usr/bin/env bash
# Live smoke against compose-published port (AGENTS: no host uvicorn for live checks).
# Covers: health, auth, JWT-gated projects/snapshot/assets/members, preview (open),
# runtime static, chapter-relative rewrite, collaboration WS token gate,
# share invite/accept, publish immutable release + public slug.
# CRDT unsaved-edit visibility: real VS Code EDH only.
set -euo pipefail
BASE="${1:-http://127.0.0.1:8000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_PROJECTS="${ROOT}/.data/projects"
WS_BASE="$(python3 -c "import sys; u=sys.argv[1].rstrip('/'); print('ws'+u[4:] if u.startswith('http') else u)" "${BASE}")"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

auth_hdr() { echo "Authorization: Bearer ${ACCESS}"; }

echo "=== compose smoke @ ${BASE} ==="

echo "GET ${BASE}/health"
HEALTH="$(curl -sfS "${BASE}/health")" || fail "health"
echo "${HEALTH}" | grep -q '"status":"ok"' || fail "health body: ${HEALTH}"
pass "health"

echo "POST /api/auth/login (demo/demo)"
LOGIN="$(curl -sfS -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo"}')" || fail "auth login"
ACCESS="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' <<<"${LOGIN}")"
REFRESH="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["refresh_token"])' <<<"${LOGIN}")"
[[ -n "${ACCESS}" && -n "${REFRESH}" ]] || fail "login missing tokens"
ME="$(curl -sfS "${BASE}/api/auth/me" -H "$(auth_hdr)")" || fail "auth me"
echo "${ME}" | grep -q '"username":"demo"' || fail "me body: ${ME}"
REF="$(curl -sfS -X POST "${BASE}/api/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"${REFRESH}\"}")" || fail "auth refresh"
echo "${REF}" | grep -q 'access_token' || fail "refresh body"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"demo","password":"wrong"}' || true)"
[[ "${CODE}" == "401" ]] || fail "expected 401 bad login, got ${CODE}"
pass "auth login/me/refresh"

echo "GET /api/projects without token → 401"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/projects" || true)"
[[ "${CODE}" == "401" ]] || fail "expected 401 no token, got ${CODE}"
pass "projects require Bearer"

NAME="smoke-$(date +%s)"
echo "POST /api/projects name=${NAME}"
CREATE="$(curl -sfS -X POST "${BASE}/api/projects" \
  -H 'Content-Type: application/json' \
  -H "$(auth_hdr)" \
  -d "{\"name\":\"${NAME}\"}")" || fail "create project"
PID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${CREATE}")"
OWNER="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("owner_id",""))' <<<"${CREATE}")"
[[ -n "${PID}" ]] || fail "no project id in ${CREATE}"
[[ "${OWNER}" == "usr_demo" ]] || fail "expected owner usr_demo, got ${OWNER}"
pass "create project ${PID} owner=${OWNER}"

echo "GET /api/projects/{id}/members"
MEMBERS="$(curl -sfS "${BASE}/api/projects/${PID}/members" -H "$(auth_hdr)")" || fail "list members"
echo "${MEMBERS}" | grep -q 'usr_demo' || fail "members missing owner: ${MEMBERS}"
pass "list members"

echo "POST members alice as editor"
ADD="$(curl -sfS -X POST "${BASE}/api/projects/${PID}/members" \
  -H 'Content-Type: application/json' \
  -H "$(auth_hdr)" \
  -d '{"username":"alice","role":"editor"}')" || fail "add member"
echo "${ADD}" | grep -q 'usr_alice' || fail "add member body: ${ADD}"
pass "add member alice"

echo "alice can GET project; stranger token cannot"
ALICE_LOGIN="$(curl -sfS -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice"}')" || fail "alice login"
ALICE_ACCESS="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' <<<"${ALICE_LOGIN}")"
curl -sfS "${BASE}/api/projects/${PID}" -H "Authorization: Bearer ${ALICE_ACCESS}" >/dev/null \
  || fail "alice get project"
# bob is not a built-in — use a forged path: login as alice on a project she is not on
# Create second project as demo; alice must 403
OTHER="$(curl -sfS -X POST "${BASE}/api/projects" \
  -H 'Content-Type: application/json' -H "$(auth_hdr)" \
  -d '{"name":"other-smoke"}')" || fail "create other"
OTHER_PID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${OTHER}")"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  "${BASE}/api/projects/${OTHER_PID}/snapshot" \
  -H "Authorization: Bearer ${ALICE_ACCESS}" || true)"
[[ "${CODE}" == "403" ]] || fail "expected 403 alice on other project, got ${CODE}"
pass "membership 403 for non-member"

echo "GET snapshot with token"
curl -sfS "${BASE}/api/projects/${PID}/snapshot" -H "$(auth_hdr)" >/dev/null || fail "snapshot"
pass "snapshot with Bearer"

echo "GET /p/${PID}/preview (open, no token)"
PREV="$(curl -sfS "${BASE}/p/${PID}/preview")" || fail "preview HTML"
echo "${PREV}" | grep -q 'reveal.js' || fail "preview missing reveal.js"
echo "${PREV}" | grep -q 'data-markdown=' || fail "preview missing slides"
echo "${PREV}" | grep -q "/runtimes/reveal-v1/" || fail "preview missing runtime urls"
if echo "${PREV}" | grep -q 'PRESENTATION_RUNTIME_CSS\|PRESENTATION_SLIDES\|PRESENTATION_RUNTIME_JS'; then
  fail "injection markers left unreplaced"
fi
pass "preview HTML injected (open)"

echo "GET /runtimes/reveal-v1/reveal.js"
curl -sfS -o /dev/null "${BASE}/runtimes/reveal-v1/reveal.js" || fail "runtime reveal.js"
pass "runtime static reveal.js"

echo "GET /runtimes/not-a-runtime/reveal.js → 404"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/runtimes/not-a-runtime/reveal.js" || true)"
[[ "${CODE}" == "404" ]] || fail "expected 404 for unknown runtime, got ${CODE}"
pass "unknown runtime 404"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/runtimes/..evil../reveal.js" || true)"
[[ "${CODE}" == "404" ]] || fail "expected 404 for non-registry runtime_name, got ${CODE}"
pass "non-registry runtime_name 404"

PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
ASSET_PATH='01-introduction/hero.png'
echo "PUT asset without token → 401"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
  "${BASE}/api/projects/${PID}/assets/${ASSET_PATH}" \
  --data-binary @<(echo "${PNG_B64}" | base64 -d) \
  -H 'Content-Type: application/octet-stream' || true)"
[[ "${CODE}" == "401" ]] || fail "expected 401 put asset no token, got ${CODE}"

echo "PUT /api/projects/${PID}/assets/${ASSET_PATH}"
echo "${PNG_B64}" | base64 -d | curl -sfS -X PUT \
  "${BASE}/api/projects/${PID}/assets/${ASSET_PATH}" \
  --data-binary @- -H 'Content-Type: application/octet-stream' \
  -H "$(auth_hdr)" >/dev/null \
  || fail "put asset"
pass "put binary asset with Bearer"

echo "GET preview asset /p/${PID}/preview/${ASSET_PATH}"
curl -sfS -o /tmp/smoke-hero.png "${BASE}/p/${PID}/preview/${ASSET_PATH}" || fail "preview asset"
python3 -c 'import pathlib; b=pathlib.Path("/tmp/smoke-hero.png").read_bytes(); assert b[:8]==b"\x89PNG\r\n\x1a\n", b[:16]' \
  || fail "preview asset not PNG"
pass "preview binary asset"

# Rewrite check uses a non-CRDT-bound chapter path (disk text).
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
    --data-binary @- -H 'Content-Type: application/octet-stream' \
    -H "$(auth_hdr)" >/dev/null \
    || fail "put 02-extra asset"
  MD_OUT="$(curl -sfS "${BASE}/p/${PID}/preview/02-extra/slide.md")" || fail "get 02-extra md"
  echo "${MD_OUT}" | grep -q "/p/${PID}/preview/02-extra/hero.png" \
    || fail "chapter-relative rewrite missing: ${MD_OUT}"
  pass "chapter-relative asset rewrite"
else
  echo "SKIP: chapter rewrite (no host workspace mount)"
fi

echo "WS collaboration without token → close 4401"
uv run python - <<PY || fail "ws no-token check"
import asyncio, json
import websockets

async def main():
    uri = "${WS_BASE}/api/projects/${PID}/collaboration"
    try:
        async with websockets.connect(uri) as ws:
            # server accepts then closes
            try:
                await asyncio.wait_for(ws.recv(), timeout=2)
            except websockets.exceptions.ConnectionClosed as e:
                assert e.code == 4401, e.code
                return
            raise SystemExit("expected close 4401")
    except websockets.exceptions.InvalidStatus:
        # some stacks reject handshake
        return
    except websockets.exceptions.ConnectionClosed as e:
        assert e.code == 4401, e.code

asyncio.run(main())
print("ws rejected without token")
PY
pass "WS rejects missing token"

echo "WS collaboration with access_token query"
uv run python - <<PY || fail "ws with token"
import asyncio, json
import websockets

async def main():
    uri = "${WS_BASE}/api/projects/${PID}/collaboration?access_token=${ACCESS}"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "client_id": "smoke-client",
            "protocol_version": 1,
            "last_known_revision": 0,
        }))
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert ready.get("type") == "ready", ready
        # optional binary snapshot
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=1)
        except TimeoutError:
            msg = None
        print("ready", ready.get("revision"))

asyncio.run(main())
PY
pass "WS hello with access_token"

echo "DELETE member alice"
DEL="$(curl -sfS -X DELETE "${BASE}/api/projects/${PID}/members/usr_alice" \
  -H "$(auth_hdr)")" || fail "delete member"
echo "${DEL}" | grep -q 'usr_demo' || fail "delete body: ${DEL}"
echo "${DEL}" | grep -q 'usr_alice' && fail "alice still present after delete"
pass "delete member alice"

echo "POST share (owner) + alice accept as viewer"
SHARE="$(curl -sfS -X POST "${BASE}/api/projects/${PID}/shares" \
  -H 'Content-Type: application/json' -H "$(auth_hdr)" \
  -d '{"role":"viewer"}')" || fail "create share"
TOKEN="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"${SHARE}")"
SHARE_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${SHARE}")"
[[ -n "${TOKEN}" && -n "${SHARE_ID}" ]] || fail "share body: ${SHARE}"
PREV_SHARE="$(curl -sfS "${BASE}/api/shares/${TOKEN}" -H "Authorization: Bearer ${ALICE_ACCESS}")" \
  || fail "preview share"
echo "${PREV_SHARE}" | grep -q "${PID}" || fail "preview share body: ${PREV_SHARE}"
ACC="$(curl -sfS -X POST "${BASE}/api/shares/accept" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer ${ALICE_ACCESS}" \
  -d "{\"token\":\"${TOKEN}\"}")" || fail "accept share"
echo "${ACC}" | grep -q '"role":"viewer"' || fail "accept role: ${ACC}"
echo "${ACC}" | grep -q '"already_member":false' || fail "expected new member: ${ACC}"
OWN="$(curl -sfS -X POST "${BASE}/api/shares/accept" \
  -H 'Content-Type: application/json' -H "$(auth_hdr)" \
  -d "{\"token\":\"${TOKEN}\"}")" || fail "owner accept"
echo "${OWN}" | grep -q '"already_member":true' || fail "owner already member: ${OWN}"
echo "${OWN}" | grep -q '"role":"owner"' || fail "owner role changed: ${OWN}"
pass "share create/accept"

echo "alice scope=shared includes project; scope=owned does not"
SHARED="$(curl -sfS "${BASE}/api/projects?scope=shared" -H "Authorization: Bearer ${ALICE_ACCESS}")" \
  || fail "list shared"
echo "${SHARED}" | grep -q "${PID}" || fail "shared list missing ${PID}: ${SHARED}"
OWNED="$(curl -sfS "${BASE}/api/projects?scope=owned" -H "Authorization: Bearer ${ALICE_ACCESS}")" \
  || fail "list owned alice"
if echo "${OWNED}" | grep -q "${PID}"; then
  fail "owned list should not include shared ${PID}: ${OWNED}"
fi
DEMO_OWNED="$(curl -sfS "${BASE}/api/projects?scope=owned" -H "$(auth_hdr)")" || fail "list owned demo"
echo "${DEMO_OWNED}" | grep -q "${PID}" || fail "owner missing from owned: ${DEMO_OWNED}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/projects?scope=nope" -H "$(auth_hdr)" || true)"
[[ "${CODE}" == "400" ]] || fail "expected 400 bad scope, got ${CODE}"
pass "project scope owned/shared"

echo "viewer cannot publish; anonymous 401"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/projects/${PID}/releases" \
  -H "Authorization: Bearer ${ALICE_ACCESS}" || true)"
[[ "${CODE}" == "403" ]] || fail "expected 403 viewer publish, got ${CODE}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/projects/${PID}/releases" || true)"
[[ "${CODE}" == "401" ]] || fail "expected 401 publish no token, got ${CODE}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/projects/${PID}/shares" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer ${ALICE_ACCESS}" \
  -d '{"role":"editor"}' || true)"
[[ "${CODE}" == "403" ]] || fail "expected 403 viewer share, got ${CODE}"
pass "publish/share permission gates"

echo "POST release from server collaborative state"
REL1_JSON="$(curl -sfS -X POST "${BASE}/api/projects/${PID}/releases" -H "$(auth_hdr)")" || fail "publish 1"
REL1="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${REL1_JSON}")"
SLUG_PATH="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["public_path"])' <<<"${REL1_JSON}")"
REL1_PATH="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["release_path"])' <<<"${REL1_JSON}")"
[[ "${REL1}" == rel_* ]] || fail "bad release id ${REL1}"
HTML1="$(curl -sfS "${BASE}${REL1_PATH}")" || fail "GET release 1"
echo "${HTML1}" | grep -q "/release/${REL1}/runtime/reveal.js" || fail "release html runtime url"
echo "${HTML1}" | grep -q "/release/${REL1}/01-introduction/slide.md" || fail "release html slide url"
if echo "${HTML1}" | grep -q "/p/${PID}/preview"; then
  fail "release html still points at live preview"
fi
curl -sfS -o /dev/null "${BASE}/release/${REL1}/runtime/reveal.js" || fail "frozen runtime file"
SLUG_HTML="$(curl -sfS "${BASE}${SLUG_PATH}")" || fail "GET slug"
echo "${SLUG_HTML}" | grep -q "/release/${REL1}/" || fail "slug did not serve release 1"
pass "publish release ${REL1} slug ${SLUG_PATH}"

if [[ ! -d "${DATA_PROJECTS}/${PID}/workspace" ]]; then
  fail "publish delta needs host project volume ${DATA_PROJECTS}/${PID}/workspace"
fi
echo "mutate server workspace disk (not CRDT) then publish again"
cat > /tmp/smoke-mutate-deck.py << 'DISKPY'
import sys
from pathlib import Path
ws = Path(sys.argv[1])
deck_path = ws / "deck.yaml"
deck = deck_path.read_text(encoding="utf-8")
needle = "  - 01-introduction\n"
if "03-delta" not in deck:
    if needle not in deck:
        raise SystemExit("deck missing introduction chapter")
    deck_path.write_text(deck.replace(needle, needle + "  - 03-delta\n", 1), encoding="utf-8")
(ws / "03-delta").mkdir(exist_ok=True)
(ws / "03-delta" / "slide.md").write_text("# DELTA_CHAPTER\n\n![hero](hero.png)\n", encoding="utf-8")
(ws / "01-introduction" / "slide.md").write_text("# DISK_ONLY_MARKER\n", encoding="utf-8")
print("mutated")
DISKPY
MUT="$(sudo python3 /tmp/smoke-mutate-deck.py "${DATA_PROJECTS}/${PID}/workspace")" || fail "mutate workspace"
echo "${MUT}" | grep -q mutated || fail "mutate output: ${MUT}"
REL2_JSON="$(curl -sfS -X POST "${BASE}/api/projects/${PID}/releases" -H "$(auth_hdr)")" || fail "publish 2"
REL2="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${REL2_JSON}")"
[[ "${REL2}" != "${REL1}" ]] || fail "release id reused"
HTML1B="$(curl -sfS "${BASE}/release/${REL1}")" || fail "reget release 1"
[[ "${HTML1B}" == "${HTML1}" ]] || fail "release 1 html changed after second publish"
HTML2="$(curl -sfS "${BASE}/release/${REL2}")" || fail "GET release 2"
echo "${HTML2}" | grep -q "03-delta/slide.md" || fail "release 2 missing delta chapter"
if echo "${HTML1B}" | grep -q "03-delta"; then
  fail "release 1 gained delta chapter"
fi
SLUG2="$(curl -sfS "${BASE}${SLUG_PATH}")" || fail "slug after republish"
echo "${SLUG2}" | grep -q "/release/${REL2}/" || fail "slug did not move to release 2"
if echo "${SLUG2}" | grep -q "/release/${REL1}/"; then
  fail "slug still pinned to release 1"
fi
S1="$(curl -sfS "${BASE}/release/${REL1}/01-introduction/slide.md")" || fail "rel1 slide"
S2="$(curl -sfS "${BASE}/release/${REL2}/01-introduction/slide.md")" || fail "rel2 slide"
echo "${S1}" | grep -q "First slide" || fail "rel1 slide lost collaborative text: ${S1}"
echo "${S2}" | grep -q "First slide" || fail "rel2 slide did not use CRDT: ${S2}"
if echo "${S1}${S2}" | grep -q "DISK_ONLY_MARKER"; then
  fail "publish followed disk edit instead of CRDT"
fi
MD2="$(curl -sfS "${BASE}/release/${REL2}/03-delta/slide.md")" || fail "delta md"
echo "${MD2}" | grep -q "/release/${REL2}/03-delta/hero.png" || fail "publish rewrite missing: ${MD2}"
LIST="$(curl -sfS "${BASE}/api/projects/${PID}/releases" -H "$(auth_hdr)")" || fail "list releases"
echo "${LIST}" | grep -q "${REL1}" || fail "history missing rel1"
echo "${LIST}" | grep -q "${REL2}" || fail "history missing rel2"
ONE="$(curl -sfS "${BASE}/api/projects/${PID}/releases/${REL1}" -H "$(auth_hdr)")" || fail "get release meta"
echo "${ONE}" | grep -q '"current":false' || fail "rel1 should not be current: ${ONE}"
TWO="$(curl -sfS "${BASE}/api/projects/${PID}/releases/${REL2}" -H "Authorization: Bearer ${ALICE_ACCESS}")" \
  || fail "viewer get release meta"
echo "${TWO}" | grep -q '"current":true' || fail "rel2 current: ${TWO}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --path-as-is \
  "${BASE}/release/${REL2}/../${REL1}/index.html" || true)"
[[ "${CODE}" == "400" || "${CODE}" == "404" ]] || fail "expected 400/404 traversal, got ${CODE}"
pass "immutable release + slug pointer"

echo "revoke share; accept fails"
REV="$(curl -sfS -X DELETE "${BASE}/api/projects/${PID}/shares/${SHARE_ID}" -H "$(auth_hdr)")" \
  || fail "revoke share"
if echo "${REV}" | grep -q "${SHARE_ID}"; then
  fail "revoked share still listed: ${REV}"
fi
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/shares/accept" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer ${ALICE_ACCESS}" \
  -d "{\"token\":\"${TOKEN}\"}" || true)"
[[ "${CODE}" == "404" ]] || fail "expected 404 revoked share, got ${CODE}"
pass "revoke share"

echo "=== all compose smoke checks passed ==="
