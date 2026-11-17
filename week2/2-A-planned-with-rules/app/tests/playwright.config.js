// ชุดทดสอบ 51 TC ของ e-Service เทศบาลนครตัวอย่าง
// ตัวแปรสภาพแวดล้อม: BASE_URL (ตั้งต้น http://localhost:3000) · DB_PATH (เฉพาะ TC-NFR-04)
const { defineConfig } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

module.exports = defineConfig({
  testDir: './specs',
  // ทุก TC เริ่มด้วย RESET (สถานะเซิร์ฟเวอร์ร่วมกัน) จึงต้องรันทีละ TC เรียงลำดับเท่านั้น
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
