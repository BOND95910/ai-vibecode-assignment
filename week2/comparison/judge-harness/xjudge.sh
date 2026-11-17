#!/usr/bin/env bash
# ไขว้ชุดเทสต์ × เว็บ:  bash xjudge.sh <SUITE A|B|C> <WEB A|B|C> <พอร์ต> <mode...>   ("" = ไม่เปิดบั๊ก)
# ผล: judge/x/results/<SUITE>-on-<WEB>/<mode>.json|.log
SUITE="$1"; WEB="$2"; PORT="$3"; shift 3
export MSYS_NO_PATHCONV=1; REPO="${REPO:-/c/src/ai-vibecode-assignment/week2}"
HERE="$(cd "$(dirname "$0")" && pwd)"; J="$(dirname "$HERE")"
OUT="$HERE/results/$SUITE-on-$WEB"; mkdir -p "$OUT"
case $WEB in
  A) APP=$REPO/2-A-planned-with-rules/app; DBH="$J/adata/app.db";;
  B) APP=$REPO/1-B-course-method/app; DBH="$J/bdata/egov.db";;
  C) APP=$REPO/3-C-usual-workflow; DBH="$J/cdata2/app.db.json";;
esac
P="x-${SUITE,,}-${WEB,,}"; NP=$((PORT+500)); FA="-f docker-compose.yml -f $(cygpath -m "$HERE")/$WEB.yml"
dc() { (cd "$APP" && COMPOSE_PROFILES=test NOHOOK_PORT=$NP PORT=$PORT WEB_PORT=$PORT BASE_URL=http://localhost:$PORT docker compose $FA -p "$P" "$@"); }
for MODE in "$@"; do
  TAG="${MODE:-none}"; TAG="${TAG//,/+}"
  dc down -v >/dev/null 2>&1; rm -f "$DBH" "$DBH"-wal "$DBH"-shm 2>/dev/null
  TEST_MODE=1 BUG_MODE="$MODE" dc up --build -d web web-nohook > "$OUT/build-$TAG.log" 2>&1 || { echo "== $SUITE/$WEB '$MODE' COMPOSE-FAILED"; continue; }
  ok=0; for i in $(seq 1 45); do curl -s localhost:$PORT/api/health | grep -qi ok && curl -s localhost:$NP/api/health | grep -qi ok && { ok=1; break; }; sleep 2; done
  [ $ok = 1 ] || { echo "== $SUITE/$WEB '$MODE' NO-HEALTH"; continue; }
  echo "== $SUITE on $WEB BUG_MODE='$MODE' $(date +%H:%M:%S)"
  JSON="$(cygpath -m "$OUT")/$TAG.json"; DBM="$(cygpath -m "$DBH")"
  export BASE_URL=http://localhost:$PORT DB_PATH="$DBM"
  case $SUITE in
    A) cd "$J/suiteA"; NO_TEST_MODE_URL=http://localhost:$NP PLAYWRIGHT_JSON_OUTPUT_NAME="$JSON" timeout 1800 npx playwright test --reporter=json,list > "$OUT/$TAG.log" 2>&1;;
    B) cd "$J/suiteB"; PLAYWRIGHT_BROWSERS_PATH=0 BASE_URL_NO_TEST_MODE=http://localhost:$NP PLAYWRIGHT_JSON_OUTPUT_NAME="$JSON" timeout 1800 npx playwright test --reporter=json,list --output="$(cygpath -m "$OUT")/art-$TAG" > "$OUT/$TAG.log" 2>&1;;
    C) cd "$J/suiteC"; PW_JSON="$JSON" NOHOOK_URL=http://localhost:$NP timeout 1800 npx playwright test > "$OUT/$TAG.log" 2>&1;;
  esac
  grep -E "^\s+[0-9]+ (passed|failed)" "$OUT/$TAG.log" | tr '\n' ' '; echo
done
dc down -v >/dev/null 2>&1
