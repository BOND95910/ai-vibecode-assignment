#!/usr/bin/env bash
# รันชุดเต็ม 51 TC กับเว็บที่เปิดด้วย docker compose ทีละ BUG_MODE (BUGS.md §3)
#   ./run-bug-matrix.sh "" "" B01 B02 ... B12 "B03,B07" "B01,B05,B09" ""
#     ""  = ไม่ตั้ง BUG_MODE (เว็บถูกต้อง) · รอบที่ "" ติดกันจะไม่ restart เว็บ (BUGS.md §3 ขั้น 2: รันซ้ำทันที)
# ทุกรอบที่เปลี่ยนโหมด: `TEST_MODE=1 BUG_MODE=<โหมด> docker compose up -d --force-recreate` แล้วรอ healthy
# ชื่อรอบ: normal-1, normal-2, … · B01 · B03+B07 · ผลอยู่ที่ tests/runs/<ชื่อรอบ>/ และสรุปบรรทัดละรอบที่ tests/runs/summary.tsv
set -u
cd "$(dirname "$0")"
APP_DIR="$(cd .. && pwd)"
PORT_NO_TEST="${NO_TEST_MODE_PORT:-3001}"

# เว็บตัวที่สอง "ไม่ตั้ง TEST_MODE" (อิมเมจเดียวกัน · DB แยกในคอนเทนเนอร์) สำหรับ TC-NFR-03 ข้อ "ปิด hook"
( cd "$APP_DIR" && docker compose build -q web >/dev/null 2>&1 )
docker rm -f egov-notestmode >/dev/null 2>&1
docker run -d --rm --name egov-notestmode -p "$PORT_NO_TEST:3000" -e TZ=Asia/Bangkok egov-eservice:local >/dev/null
export BASE_URL_NO_TEST_MODE="http://localhost:$PORT_NO_TEST"

prev="__none__"; n_normal=$(ls -d runs/normal-* 2>/dev/null | wc -l)
for mode in "$@"; do
  if [ -z "$mode" ]; then n_normal=$((n_normal+1)); name="normal-$n_normal"; else name="${mode//,/+}"; fi
  if [ "$mode" != "$prev" ]; then
    ( cd "$APP_DIR" && TEST_MODE=1 BUG_MODE="$mode" docker compose up -d --force-recreate >/dev/null 2>&1 )
  fi
  prev="$mode"
  cid=$(cd "$APP_DIR" && docker compose ps -q web)
  for i in $(seq 1 60); do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)
    [ "$s" = healthy ] && break; sleep 1
  done
  banner=$(docker logs "$cid" 2>&1 | grep 'listening on' | tail -1)
  echo "== $name · health=$s · $banner"
  ./run-suite.sh "$name"
  echo "$banner" > "runs/$name/server-banner.txt"
  node -e '
    const r=require(process.argv[1]); const out=[];
    const walk=s=>{for(const x of s.suites||[])walk(x); for(const sp of s.specs||[]) for(const t of sp.tests){const st=t.results.at(-1)?.status; out.push([sp.title.split(" ")[0], st]);}};
    for(const s of r.suites) walk(s);
    const failed=out.filter(([,s])=>s!=="passed").map(([t])=>t);
    console.log([process.argv[2], out.length-failed.length, failed.length, failed.join(" ")||"-"].join("\t"));
  ' "$PWD/runs/$name/results.json" "$name" | tee -a runs/summary.tsv
done
docker rm -f egov-notestmode >/dev/null 2>&1
