#!/usr/bin/env bash
# รันชุด Playwright เต็ม 51 TC กับ BUG_MODE ทีละชุด แล้วเก็บ JSON ผลต่อรอบ
# ใช้: bash test-report/bughunt.sh "" B01 B02 ... "B03,B07"   ("" = ไม่เปิดบั๊ก)
PORT=3111
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"; OUT="${OUT_DIR:-$ROOT/test-report/bug-runs}"   # OUT_DIR=… แยกโฟลเดอร์ผลต่อ sweep (ใช้เทียบ flaky)
mkdir -p "$OUT"
stop_server() {
  local pid
  pid=$(netstat -ano | grep ":$PORT " | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "$pid" ] && taskkill //PID "$pid" //F >/dev/null 2>&1
  sleep 1
}
for MODE in "$@"; do
  NAME="${MODE:-none}"; NAME="${NAME//,/+}"
  stop_server
  rm -f "$APP"/data/app.db*
  (cd "$APP" && TEST_MODE=1 BUG_MODE="$MODE" PORT=$PORT BASE_URL=http://localhost:$PORT DB_PATH="$APP/data/app.db" nohup node server/index.js > "$OUT/server-$NAME.log" 2>&1 &)
  for i in $(seq 1 20); do curl -s localhost:$PORT/api/health | grep -q ok && break; sleep 1; done
  echo "== BUG_MODE='$MODE' $(date +%H:%M:%S)"
  (cd "$APP/tests" && PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/$NAME.json" BASE_URL=http://localhost:$PORT DB_PATH="$APP/data/app.db" timeout 1500 npx playwright test --reporter=json,list > "$OUT/$NAME.log" 2>&1)
  grep -E "^\s+[0-9]+ (passed|failed)" "$OUT/$NAME.log" | tr '\n' ' '; echo
done
stop_server
