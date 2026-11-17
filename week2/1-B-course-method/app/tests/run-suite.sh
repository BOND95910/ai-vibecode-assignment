#!/usr/bin/env bash
# รันชุด Playwright เต็ม 51 TC กับเว็บที่เปิดอยู่ แล้วเก็บผลไว้ที่ tests/runs/<ชื่อรอบ>/
#   ./run-suite.sh normal-1                 # BASE_URL ค่าตั้งต้น http://localhost:3000
#   BASE_URL=http://localhost:3013 ./run-suite.sh B01
# ผลในโฟลเดอร์รอบ: list.txt (reporter list) · results.json · artifacts/ (trace/screenshot ของ TC ที่ล้ม) · web.log (log ของเว็บระหว่างรอบ)
#
# - เครื่องนี้มี chromium build 1252 แต่ Playwright 1.65.1 ต้องการ 1255 → ใช้โฟลเดอร์ symlink .pw-browsers ให้เอง
# - ถ้าเว็บรันด้วย docker compose (โฟลเดอร์ app/) จะเก็บ `docker compose logs` ระหว่างรอบเป็น web.log
#   แล้วส่งให้ TC-NFR-04 ค้นข้อมูลส่วนบุคคลใน log ด้วย (PII_SCAN_PATHS)
# - TC-NFR-03 ตรวจ "เว็บที่ไม่ตั้ง TEST_MODE → POST /api/test/reset = 404" เมื่อมี BASE_URL_NO_TEST_MODE
#   (run-bug-matrix.sh เปิดคอนเทนเนอร์ egov-notestmode ที่ :3001 ให้ · ถ้ามีอยู่แล้วสคริปต์นี้ใช้ให้อัตโนมัติ)
set -u
cd "$(dirname "$0")"
APP_DIR="$(cd .. && pwd)"
name="${1:?usage: run-suite.sh <run-name> [playwright args...]}"; shift
out="runs/$name"; rm -rf "$out"; mkdir -p "$out"

need=$(node -e "const f=require('path').join(require.resolve('playwright-core/package.json'),'../browsers.json');console.log(JSON.parse(require('fs').readFileSync(f,'utf8')).browsers.find(x=>x.name==='chromium-headless-shell').revision)")
[ -n "$need" ] || { echo "อ่าน revision ของ chromium จาก playwright-core ไม่ได้" >&2; exit 2; }
have="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ ! -d "$have/chromium_headless_shell-$need" ] && [ -d /ms-playwright/chromium-1252 ]; then
  mkdir -p .pw-browsers
  ln -sfn /ms-playwright/chromium-1252 ".pw-browsers/chromium-$need"
  ln -sfn /ms-playwright/chromium_headless_shell-1252 ".pw-browsers/chromium_headless_shell-$need"
  ln -sfn /ms-playwright/ffmpeg-1013 .pw-browsers/ffmpeg-1013
  export PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers"
fi

if [ -z "${BASE_URL_NO_TEST_MODE:-}" ] && command -v docker >/dev/null 2>&1 \
   && [ "$(docker inspect -f '{{.State.Running}}' egov-notestmode 2>/dev/null)" = true ]; then
  export BASE_URL_NO_TEST_MODE="http://localhost:${NO_TEST_MODE_PORT:-3001}"
fi

logpid=""
if command -v docker >/dev/null 2>&1 && [ -n "$(cd "$APP_DIR" && docker compose ps -q web 2>/dev/null)" ]; then
  ( cd "$APP_DIR" && exec docker compose logs -f --no-color web ) > "$out/web.log" 2>&1 &
  logpid=$!
  export PII_SCAN_PATHS="${PII_SCAN_PATHS:+$PII_SCAN_PATHS,}$PWD/$out/web.log"
fi

start=$(date +%s)
PLAYWRIGHT_JSON_OUTPUT_NAME="$out/results.json" \
  npx playwright test --reporter=list,json --output="$out/artifacts" "$@" > "$out/list.txt" 2>&1
rc=$?
end=$(date +%s)
[ -n "$logpid" ] && kill "$logpid" 2>/dev/null
echo "rc=$rc seconds=$((end-start)) BASE_URL=${BASE_URL:-http://localhost:3000} BASE_URL_NO_TEST_MODE=${BASE_URL_NO_TEST_MODE:-} PII_SCAN_PATHS=${PII_SCAN_PATHS:-}" >> "$out/list.txt"
grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)|^rc=' "$out/list.txt"
exit $rc
