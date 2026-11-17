// ตัวแปรสภาพแวดล้อมของชุดทดสอบ
const path = require('node:path');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
// ค่าตั้งต้นของเว็บ: ./data/app.db ในโฟลเดอร์ app (ARCHITECTURE.md) · tests/ อยู่ใต้ app/
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', '..', 'data', 'app.db');

module.exports = { BASE_URL, DB_PATH };
