#!/usr/bin/env python3
"""TC-NFR-04 (inspection นอก Playwright) — ค้นค่าข้อมูลส่วนบุคคลตรงตัวในฐานข้อมูลของเว็บ

  python3 -I tests/inspect-pii.py data/egov.db [ไฟล์ log ...]

ตรวจ 3 แบบตามการ์ด: (1) ไบต์ดิบของไฟล์ DB + -wal/-shm/-journal (เหมือน grep -a -c)
(2) ข้อความจาก `.dump` ทั้งฐาน (sqlite3 iterdump · เปิดแบบอ่านอย่างเดียว) (3) ไฟล์ log/ดัมพ์ที่ส่งมา
คาดหวัง: จำนวนที่พบ = 0 ทุกค่า · ออกด้วยรหัส 1 ถ้าพบค่าใดค่าหนึ่ง
"""
import os
import sqlite3
import sys

VALUES = [
    '1101700123456', '3100600987659', '1909900555015', '5500400111221',
    '0812345678', '0823456789', '0834567890', '0845678901',
    '1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1',
]


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    db = argv[1]
    raw_files = [p for p in (db, db + '-wal', db + '-shm', db + '-journal') if os.path.isfile(p)]
    logs = [p for p in argv[2:] if os.path.isfile(p)]
    blobs = {p: open(p, 'rb').read() for p in raw_files + logs}

    con = sqlite3.connect('file:%s?mode=ro' % os.path.abspath(db), uri=True)
    dump = '\n'.join(con.iterdump())
    tables = [r[0] for r in con.execute("select name from sqlite_master where type='table' order by name")]
    users = con.execute("select count(*), sum(id_enc like 'v1:%'), sum(mobile_enc like 'v1:%') from users where role='citizen'").fetchone()
    con.close()

    print('files     :', ', '.join('%s (%d B)' % (p, len(b)) for p, b in blobs.items()))
    print('dump      : %d chars · tables: %s' % (len(dump), ' '.join(tables)))
    print('citizens  : %d rows · id_enc v1:* = %d · mobile_enc v1:* = %d' % users)
    print('%-20s %6s %6s %6s' % ('value', 'raw', 'dump', 'logs'))
    found = 0
    for v in VALUES:
        n_raw = sum(blobs[p].count(v.encode()) for p in raw_files)
        n_dump = dump.count(v)
        n_log = sum(blobs[p].count(v.encode()) for p in logs)
        found += n_raw + n_dump + n_log
        print('%-20s %6d %6d %6d' % (v, n_raw, n_dump, n_log))
    print('TOTAL FOUND =', found)
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
