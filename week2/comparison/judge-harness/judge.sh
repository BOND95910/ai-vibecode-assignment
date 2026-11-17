#!/usr/bin/env bash
# ตรวจเว็บของแต่ละแบบด้วยชุดเทสต์กลาง (suiteA) ผ่าน docker compose ของแบบนั้นเอง
# ใช้: [COMPOSE_OVERRIDE=ไฟล์.yml] [DBP=พาธไฟล์ฐานข้อมูลบนเครื่อง] bash judge.sh <ชื่อ> <โฟลเดอร์ที่มี docker-compose.yml> <พอร์ต> <mode...>   ("" = ไม่เปิดบั๊ก)
# ผล: judge/results/<ชื่อ>/<mode>.json + .log + build-*.log
NAME="$1"; APP="$2"; PORT="$3"; shift 3
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$HERE/results/$NAME"; mkdir -p "$OUT"
P="judge-${NAME,,}"
FARGS=""; [ -n "$COMPOSE_OVERRIDE" ] && FARGS="-f docker-compose.yml -f $COMPOSE_OVERRIDE"
for MODE in "$@"; do
  TAG="${MODE:-none}"; TAG="${TAG//,/+}"
  (cd "$APP" && docker compose $FARGS -p "$P" down -v >/dev/null 2>&1)
  (cd "$APP" && PORT=$PORT WEB_PORT=$PORT BASE_URL=http://localhost:$PORT TEST_MODE=1 BUG_MODE="$MODE" docker compose $FARGS -p "$P" up --build -d web > "$OUT/build-$TAG.log" 2>&1) || { echo "== $NAME BUG_MODE='$MODE' COMPOSE-FAILED"; continue; }
  ok=0; for i in $(seq 1 40); do curl -s localhost:$PORT/api/health | grep -qi ok && { ok=1; break; }; sleep 2; done
  [ $ok = 1 ] || { echo "== $NAME BUG_MODE='$MODE' NO-HEALTH"; continue; }
  echo "== $NAME BUG_MODE='$MODE' $(date +%H:%M:%S)"
  (cd "$HERE/suiteA" && PLAYWRIGHT_JSON_OUTPUT_NAME="$(cygpath -m "$OUT")/$TAG.json" DB_PATH="${DBP:-}" BASE_URL=http://localhost:$PORT timeout 1500 npx playwright test --reporter=json,list > "$OUT/$TAG.log" 2>&1)
  grep -E "^\s+[0-9]+ (passed|failed)" "$OUT/$TAG.log" | tr '\n' ' '; echo
done
(cd "$APP" && docker compose $FARGS -p "$P" down -v >/dev/null 2>&1)
