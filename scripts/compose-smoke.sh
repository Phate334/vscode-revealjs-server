#!/usr/bin/env bash
# Live smoke against compose-published port (AGENTS: no host uvicorn for live checks).
# Covers: health, auth, JWT-gated projects/snapshot/assets/members, private preview sessions,
# project-local runtime, chapter-relative rewrite, collaboration WS token gate,
# account invite register, open-by-id without membership, publish self-contained release + presentation slug.
# CRDT unsaved-edit visibility: real VS Code EDH only.
set -euo pipefail
BASE="${1:-http://127.0.0.1:8000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_PROJECTS="${ROOT}/.data/projects"
WS_BASE="$(python3 -c "import sys; u=sys.argv[1].rstrip('/'); print('ws'+u[4:] if u.startswith('http') else u)" "${BASE}")"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

auth_hdr() { echo "Authorization: Bearer ${ACCESS}"; }
json_login() {
  python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$1" "$2"
}

# Empty server: first user registers. No AUTH_DEMO_USER required.
STAMP="$(date +%s)"
SMOKE_USER="smoke-${STAMP}"
SMOKE_PASS="smoke-pass-${STAMP}"
SMOKE_GUEST="guest-${STAMP}"
SMOKE_GUEST_PASS="guest-pass-${STAMP}"
SMOKE_JOIN="join-${STAMP}"
SMOKE_JOIN_PASS="join-pass-${STAMP}"

echo "=== compose smoke @ ${BASE} ==="

echo "GET ${BASE}/health"
HEALTH="$(curl -sfS "${BASE}/health")" || fail "health"
echo "${HEALTH}" | grep -q '"status":"ok"' || fail "health body: ${HEALTH}"
pass "health"

echo "POST /api/auth/register (${SMOKE_USER}) without a seed account"
LOGIN="$(curl -sfS -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "$(json_login "${SMOKE_USER}" "${SMOKE_PASS}")")" || fail "auth register"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' -d "$(json_login "${SMOKE_USER}" "${SMOKE_PASS}")" || true)"
[[ "${CODE}" == "409" ]] || fail "expected 409 duplicate register, got ${CODE}"
echo "POST /api/auth/login (${SMOKE_USER})"
LOGIN="$(curl -sfS -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(json_login "${SMOKE_USER}" "${SMOKE_PASS}")")" || fail "auth login"
ACCESS="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' <<<"${LOGIN}")"
REFRESH="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["refresh_token"])' <<<"${LOGIN}")"
[[ -n "${ACCESS}" && -n "${REFRESH}" ]] || fail "login missing tokens"
ME="$(curl -sfS "${BASE}/api/auth/me" -H "$(auth_hdr)")" || fail "auth me"
echo "${ME}" | grep -Fq "\"username\":\"${SMOKE_USER}\"" || fail "me body: ${ME}"
ME_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${ME}")"
REF="$(curl -sfS -X POST "${BASE}/api/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"${REFRESH}\"}")" || fail "auth refresh"
echo "${REF}" | grep -q 'access_token' || fail "refresh body"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' -d "$(json_login "${SMOKE_USER}" "wrong")" || true)"
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
[[ "${OWNER}" == "${ME_ID}" ]] || fail "expected owner ${ME_ID}, got ${OWNER}"
pass "create project ${PID} owner=${OWNER}"

echo "GET /api/projects/{id}/members"
MEMBERS="$(curl -sfS "${BASE}/api/projects/${PID}/members" -H "$(auth_hdr)")" || fail "list members"
echo "${MEMBERS}" | grep -q "${ME_ID}" || fail "members missing owner: ${MEMBERS}"
pass "list members"

echo "guest registers and can open a project without being a member"
GUEST_LOGIN="$(curl -sfS -X POST "${BASE}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "$(json_login "${SMOKE_GUEST}" "${SMOKE_GUEST_PASS}")")" || fail "guest register"
GUEST_ACCESS="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' <<<"${GUEST_LOGIN}")"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  "${BASE}/api/projects/${PID}" \
  -H "Authorization: Bearer ${GUEST_ACCESS}" || true)"
[[ "${CODE}" == "200" ]] || fail "expected 200 guest read, got ${CODE}"
OTHER="$(curl -sfS -X POST "${BASE}/api/projects" \
  -H 'Content-Type: application/json' -H "$(auth_hdr)" \
  -d '{"name":"other-smoke"}')" || fail "create other"
OTHER_PID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${OTHER}")"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
  "${BASE}/api/projects/${OTHER_PID}/snapshot" \
  -H "Authorization: Bearer ${GUEST_ACCESS}" || true)"
[[ "${CODE}" == "200" ]] || fail "expected 200 guest snapshot, got ${CODE}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "${BASE}/api/projects/${PID}/members" \
  -H 'Content-Type: application/json' -H "$(auth_hdr)" \
  -d '{"username":"guest","role":"editor"}' || true)"
[[ "${CODE}" == "404" || "${CODE}" == "405" ]] || fail "expected POST /members removed, got ${CODE}"
pass "authenticated read does not require membership"

echo "GET snapshot with token"
curl -sfS "${BASE}/api/projects/${PID}/snapshot" -H "$(auth_hdr)" >/dev/null || fail "snapshot"
pass "snapshot with Bearer"

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/preview/${PID}/")"
[[ "$CODE" == "401" ]] || fail "private preview must reject anonymous access"
SESSION="$(curl -sfS -X POST "${BASE}/api/projects/${PID}/preview-session" -H "$(auth_hdr)")"
PREVIEW_URL="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])' <<<"$SESSION")"
curl -sfS -L -c "$COOKIE_JAR" -b "$COOKIE_JAR" "${BASE}${PREVIEW_URL}" >/dev/null || fail "preview session bootstrap"
echo "GET authorized private preview"
PREV="$(curl -sfS -b "${COOKIE_JAR}" "${BASE}/preview/${PID}/")" || fail "preview HTML"
echo "${PREV}" | grep -q 'reveal.js' || fail "preview missing reveal.js"
echo "${PREV}" | grep -q 'data-markdown=' || fail "preview missing slides"
echo "${PREV}" | grep -q 'runtime/reveal.js' || fail "preview missing project-local runtime urls"
if echo "${PREV}" | grep -q '/runtimes/'; then
  fail "preview still points at shared /runtimes/"
fi
if echo "${PREV}" | grep -q 'PRESENTATION_RUNTIME_CSS\|PRESENTATION_SLIDES\|PRESENTATION_RUNTIME_JS'; then
  fail "injection markers left unreplaced"
fi
pass "preview HTML with scoped session"

echo "GET /preview/${PID}/runtime/reveal.js"
curl -sfS -o /dev/null -b "${COOKIE_JAR}" "${BASE}/preview/${PID}/runtime/reveal.js" || fail "project runtime reveal.js"
pass "project-local runtime reveal.js"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/runtimes/reveal-v1/reveal.js" || true)"
[[ "${CODE}" == "404" ]] || fail "expected 404 for removed /runtimes, got ${CODE}"
pass "shared /runtimes removed (404)"

PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
ASSET_PATH='01-introduction/hero.png'
echo "PUT asset without token → 401"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
  "${BASE}/api/projects/${PID}/assets/${ASSET_PATH}" \
  --data-binary @<(echo "${PNG_B64}" | base64 -d) \
  -H 'Content-Type: application/octet-stream' || true)"
[[ "${CODE}" == "401" ]] || fail "expected 401 put asset no token, got ${CODE}"

echo "PUT /api/projects/${PID}/assets/${ASSET_PATH}"
PUT1="$(echo "${PNG_B64}" | base64 -d | curl -sfS -X PUT \
  "${BASE}/api/projects/${PID}/assets/${ASSET_PATH}?base_revision=0" \
  --data-binary @- -H 'Content-Type: application/octet-stream' \
  -H "$(auth_hdr)")" \
  || fail "put asset"
ASSET_REV="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])' <<<"${PUT1}")"
[[ -n "${ASSET_REV}" ]] || fail "put asset missing revision: ${PUT1}"
pass "put binary asset with Bearer rev=${ASSET_REV}"

echo "PUT same asset without matching base_revision → 409 AssetConflict"
CODE="$(echo "${PNG_B64}" | base64 -d | curl -sS -o /tmp/smoke-asset-conflict.json -w '%{http_code}' -X PUT \
  "${BASE}/api/projects/${PID}/assets/${ASSET_PATH}?base_revision=0" \
  --data-binary @- -H 'Content-Type: application/octet-stream' \
  -H "$(auth_hdr)" || true)"
[[ "${CODE}" == "409" ]] || fail "expected 409 asset conflict, got ${CODE}"
python3 -c 'import json; d=json.load(open("/tmp/smoke-asset-conflict.json")); detail=d.get("detail", d); assert detail.get("error")=="AssetConflict", detail' \
  || fail "409 body not AssetConflict"
pass "asset optimistic concurrency 409"

echo "PUT force overwrite after conflict"
echo "${PNG_B64}" | base64 -d | curl -sfS -X PUT \
  "${BASE}/api/projects/${PID}/assets/${ASSET_PATH}?force=true" \
  --data-binary @- -H 'Content-Type: application/octet-stream' \
  -H "$(auth_hdr)" >/dev/null \
  || fail "force put asset"
pass "asset force overwrite"

echo "GET preview asset /preview/${PID}/${ASSET_PATH}"
curl -sfS -o /tmp/smoke-hero.png -b "${COOKIE_JAR}" "${BASE}/preview/${PID}/${ASSET_PATH}" || fail "preview asset"
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
  MD_OUT="$(curl -sfS -b "${COOKIE_JAR}" "${BASE}/preview/${PID}/02-extra/slide.md")" || fail "get 02-extra md"
  echo "${MD_OUT}" | grep -q "/preview/${PID}/02-extra/hero.png" \
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
            "protocol_version": 2,
            "last_known_structure_revision": 0,
        }))
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert ready.get("type") == "ready", ready
        # optional binary snapshot
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=1)
        except TimeoutError:
            msg = None
        print("ready", ready.get("structure_revision"))

asyncio.run(main())
PY
pass "WS hello with access_token"

echo "account invite registers a new user and does not require a project"
INVITE="$(curl -sfS -X POST "${BASE}/api/account-invites" -H "$(auth_hdr)")" || fail "create account invite"
TOKEN="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"${INVITE}")"
INVITE_URL="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])' <<<"${INVITE}")"
[[ -n "${TOKEN}" ]] || fail "invite body: ${INVITE}"
echo "${INVITE_URL}" | grep -Fq "/join#${TOKEN}" || fail "invite url missing token: ${INVITE_URL}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/join" || true)"
[[ "${CODE}" == "200" ]] || fail "expected 200 GET /join, got ${CODE}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/account-invites" || true)"
[[ "${CODE}" == "401" ]] || fail "expected 401 create invite without auth, got ${CODE}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/account-invites/not-a-token" || true)"
[[ "${CODE}" == "404" ]] || fail "expected 404 unknown invite, got ${CODE}"
JOIN="$(curl -sfS -X POST "${BASE}/api/account-invites/${TOKEN}/register" \
  -H 'Content-Type: application/json' \
  -d "$(json_login "${SMOKE_JOIN}" "${SMOKE_JOIN_PASS}")")" || fail "register via invite"
JOIN_ACCESS="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' <<<"${JOIN}")"
[[ -n "${JOIN_ACCESS}" ]] || fail "invite register body: ${JOIN}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/account-invites/${TOKEN}/register" \
  -H 'Content-Type: application/json' -d "$(json_login "${SMOKE_JOIN}" "${SMOKE_JOIN_PASS}")" || true)"
[[ "${CODE}" == "409" ]] || fail "expected 409 existing username, got ${CODE}"
LINK="$(curl -sfS "${BASE}/api/projects/${PID}/link" -H "$(auth_hdr)")" || fail "project link"
echo "${LINK}" | grep -Fq "/open#${PID}" || fail "presentation link: ${LINK}"
curl -sfS "${BASE}/api/projects/${PID}/snapshot" -H "Authorization: Bearer ${JOIN_ACCESS}" >/dev/null \
  || fail "new account could not read project"
pass "account invite + presentation link"

echo "guest is not listed as owner or member of the project"
SHARED="$(curl -sfS "${BASE}/api/projects?scope=shared" -H "Authorization: Bearer ${GUEST_ACCESS}")" \
  || fail "list shared"
if echo "${SHARED}" | grep -q "${PID}"; then
  fail "shared list should not include ${PID}: ${SHARED}"
fi
OWNED="$(curl -sfS "${BASE}/api/projects?scope=owned" -H "Authorization: Bearer ${GUEST_ACCESS}")" \
  || fail "list owned guest"
if echo "${OWNED}" | grep -q "${PID}"; then
  fail "owned list should not include ${PID}: ${OWNED}"
fi
OWNER_LIST="$(curl -sfS "${BASE}/api/projects?scope=owned" -H "$(auth_hdr)")" || fail "list owned owner"
echo "${OWNER_LIST}" | grep -q "${PID}" || fail "owner missing from owned: ${OWNER_LIST}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/projects?scope=nope" -H "$(auth_hdr)" || true)"
[[ "${CODE}" == "400" ]] || fail "expected 400 bad scope, got ${CODE}"
pass "project scope owned/shared"

echo "anonymous publish is 401; a signed-in non-member may read the project"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/projects/${PID}/publish" || true)"
[[ "${CODE}" == "401" ]] || fail "expected 401 publish no token, got ${CODE}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/projects/${PID}" \
  -H "Authorization: Bearer ${JOIN_ACCESS}" || true)"
[[ "${CODE}" == "200" ]] || fail "expected 200 invite user read, got ${CODE}"
pass "publish auth gate"

echo "POST publish from server collaborative state"
REL1_JSON="$(curl -sfS -X POST "${BASE}/api/projects/${PID}/publish" -H "$(auth_hdr)")" || fail "publish 1"
REL1="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${REL1_JSON}")"
SLUG_PATH="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["public_path"])' <<<"${REL1_JSON}")"
REL1_PATH="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["release_path"])' <<<"${REL1_JSON}")"
[[ "${REL1}" == rel_* ]] || fail "bad release id ${REL1}"
[[ "${SLUG_PATH}" == /presentations/* ]] || fail "bad public_path ${SLUG_PATH}"
[[ "${REL1_PATH}" == "/releases/${REL1}" ]] || fail "bad release_path ${REL1_PATH}"
HTML1="$(curl -sfS "${BASE}${REL1_PATH}/")" || fail "GET release 1"
echo "${HTML1}" | grep -q 'runtime/reveal.js' || fail "release html should use relative runtime/"
if echo "${HTML1}" | grep -q '/runtimes/'; then
  fail "release html still points at shared /runtimes/"
fi
echo "${HTML1}" | grep -q 'data-markdown="01-introduction/slide.md"' || fail "release html slide url"
if echo "${HTML1}" | grep -q "/preview/${PID}"; then
  fail "release html still points at live preview"
fi
curl -sfS -o /dev/null "${BASE}${REL1_PATH}/runtime/reveal.js" || fail "release-local runtime file"
curl -sfS -o /tmp/smoke-rel-hero.png "${BASE}${REL1_PATH}/${ASSET_PATH}" || fail "release asset inline"
python3 -c 'import pathlib; b=pathlib.Path("/tmp/smoke-rel-hero.png").read_bytes(); assert b[:8]==b"\x89PNG\r\n\x1a\n", b[:16]' \
  || fail "release asset not PNG"
# No assets.json / blobs in release tree
if [[ -f "${DATA_PROJECTS}/${PID}/releases/${REL1}/assets.json" ]]; then
  fail "release should not have assets.json"
fi
SLUG_HTML="$(curl -sfS "${BASE}${SLUG_PATH}/")" || fail "GET presentation slug"
echo "${SLUG_HTML}" | grep -q 'data-markdown="01-introduction/slide.md"' || fail "slug missing slides"
[[ "${SLUG_HTML}" == "${HTML1}" ]] || fail "slug html differs from release 1"
pass "publish release ${REL1} slug ${SLUG_PATH}"

if [[ ! -d "${DATA_PROJECTS}/${PID}/workspace" ]]; then
  fail "publish delta needs host project volume ${DATA_PROJECTS}/${PID}/workspace"
fi
echo "multi-doc: CRDT index.html+delta chapter; disk-only slide marker (CRDT wins)"
# Disk-only clobber of bound slide — Publish must keep CRDT text, not DISK_ONLY_MARKER.
sudo python3 - <<DISKPY || fail "disk-only slide mutate"
from pathlib import Path
ws = Path("${DATA_PROJECTS}/${PID}/workspace")
(ws / "01-introduction" / "slide.md").write_text("# DISK_ONLY_MARKER\n", encoding="utf-8")
print("disk_slide_mutated")
DISKPY
# Live CRDT: patch index.html section list + create 03-delta/slide.md (path→Y.Text + HTTP workspace operations).
uv run python - <<CRDTPY || fail "multi-doc CRDT delta"
import asyncio, json
import websockets
from pycrdt import Doc, Map, Text

PID = "${PID}"
URI = "${WS_BASE}/api/projects/${PID}/collaboration?access_token=${ACCESS}"
DELTA_MD = "# DELTA_CHAPTER\n\n![hero](hero.png)\n"

async def main() -> None:
    doc = Doc()
    async with websockets.connect(URI) as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "client_id": "smoke-multidoc",
            "protocol_version": 2,
            "last_known_structure_revision": 0,
        }))
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert ready.get("type") == "ready", ready
        if ready.get("has_snapshot"):
            snap = await asyncio.wait_for(ws.recv(), timeout=5)
            assert isinstance(snap, (bytes, bytearray))
            doc.apply_update(bytes(snap))
        docs = doc.get("documents", type=Map)
        keys = list(docs.keys())
        assert "index.html" in keys, keys
        assert any(str(k).endswith("slide.md") for k in keys), keys
        # Patch index.html in CRDT: add 03-delta section
        before = doc.get_state()
        index = docs.get("index.html")
        assert index is not None
        cur = str(index)
        needle = 'data-markdown="01-introduction/slide.md"'
        assert needle in cur, cur
        if "03-delta/slide.md" not in cur:
            start = cur.rfind("<section", 0, cur.find(needle))
            end = cur.find("</section>", cur.find(needle)) + len("</section>")
            assert start >= 0 and end > start, cur[:240]
            sec = cur[start:end].replace(
                "01-introduction/slide.md", "03-delta/slide.md", 1
            )
            new_html = cur[:end] + "\n" + sec + cur[end:]
            index.clear()
            index.insert(0, new_html)
        # Ensure delta slide text in documents map
        if docs.get("03-delta/slide.md") is None:
            yt = Text()
            docs["03-delta/slide.md"] = yt
            yt.insert(0, DELTA_MD)
        elif not str(docs["03-delta/slide.md"]):
            docs["03-delta/slide.md"].insert(0, DELTA_MD)
        upd = doc.get_update(before)
        if upd and upd != b"\x00\x00":
            await ws.send(upd)
        # Ordered CRDT stream barrier before durable HTTP topology commands.
        await ws.send(json.dumps({"type": "ping", "id": "smoke-barrier"}))
        while True:
            frame = await asyncio.wait_for(ws.recv(), timeout=5)
            if isinstance(frame, str) and json.loads(frame).get("type") == "pong":
                break
        import urllib.request
        request = urllib.request.Request(
            "${BASE}/api/projects/${PID}/workspace/operations",
            data=json.dumps({
                "base_revision": ready["structure_revision"],
                "operations": [
                    {"id": "smoke_delta_mkdir", "kind": "mkdir", "path": "03-delta"},
                    {"id": "smoke_delta_create", "kind": "create", "path": "03-delta/slide.md", "content": DELTA_MD},
                ],
            }).encode(),
            headers={"Authorization": "Bearer ${ACCESS}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            result = json.load(response)
        assert len(result["results"]) == 2, result
        print("multidoc_delta_ok", sorted(str(k) for k in docs.keys()))

asyncio.run(main())
CRDTPY

REL2_JSON="$(curl -sfS -X POST "${BASE}/api/projects/${PID}/publish" -H "$(auth_hdr)")" || fail "publish 2"
REL2="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"${REL2_JSON}")"
[[ "${REL2}" != "${REL1}" ]] || fail "release id reused"
HTML1B="$(curl -sfS "${BASE}/releases/${REL1}/")" || fail "reget release 1"
[[ "${HTML1B}" == "${HTML1}" ]] || fail "release 1 html changed after second publish"
HTML2="$(curl -sfS "${BASE}/releases/${REL2}/")" || fail "GET release 2"
echo "${HTML2}" | grep -q 'data-markdown="03-delta/slide.md"' || fail "release 2 missing delta chapter"
if echo "${HTML1B}" | grep -q "03-delta"; then
  fail "release 1 gained delta chapter"
fi
SLUG2="$(curl -sfS "${BASE}${SLUG_PATH}/")" || fail "slug after republish"
echo "${SLUG2}" | grep -q 'data-markdown="03-delta/slide.md"' || fail "slug did not move to release 2"
[[ "${SLUG2}" == "${HTML2}" ]] || fail "slug html differs from release 2"
S1="$(curl -sfS "${BASE}/releases/${REL1}/01-introduction/slide.md")" || fail "rel1 slide"
S2="$(curl -sfS "${BASE}/releases/${REL2}/01-introduction/slide.md")" || fail "rel2 slide"
echo "${S1}" | grep -q "First slide" || fail "rel1 slide lost collaborative text: ${S1}"
echo "${S2}" | grep -q "First slide" || fail "rel2 slide did not use CRDT: ${S2}"
if echo "${S1}${S2}" | grep -q "DISK_ONLY_MARKER"; then
  fail "publish followed disk edit instead of CRDT"
fi
MD2="$(curl -sfS "${BASE}/releases/${REL2}/03-delta/slide.md")" || fail "delta md"
echo "${MD2}" | grep -q "/releases/${REL2}/03-delta/hero.png" || fail "publish rewrite missing: ${MD2}"
LIST="$(curl -sfS "${BASE}/api/projects/${PID}/releases" -H "$(auth_hdr)")" || fail "list releases"
echo "${LIST}" | grep -q "${REL1}" || fail "history missing rel1"
echo "${LIST}" | grep -q "${REL2}" || fail "history missing rel2"
ONE="$(curl -sfS "${BASE}/api/projects/${PID}/releases/${REL1}" -H "$(auth_hdr)")" || fail "get release meta"
echo "${ONE}" | grep -q '"current":false' || fail "rel1 should not be current: ${ONE}"
TWO="$(curl -sfS "${BASE}/api/releases/${REL2}" -H "Authorization: Bearer ${GUEST_ACCESS}")" \
  || fail "viewer get release meta via /api/releases"
echo "${TWO}" | grep -q '"current":true' || fail "rel2 current: ${TWO}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --path-as-is \
  "${BASE}/releases/${REL2}/../${REL1}/index.html" || true)"
[[ "${CODE}" == "400" || "${CODE}" == "404" ]] || fail "expected 400/404 traversal, got ${CODE}"
pass "immutable release + presentation slug pointer"

echo "=== all compose smoke checks passed ==="
