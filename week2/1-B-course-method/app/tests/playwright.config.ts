import { defineConfig, devices } from '@playwright/test';

/**
 * ชุดทดสอบกลาง 51 TC (TEST-PLAN.md)
 * - ทุก TC เริ่มด้วย POST /api/test/reset → สถานะของเว็บเป็นของกลางทั้งระบบ
 *   จึงต้องรันทีละ test (workers: 1, ไม่ fullyParallel)
 * - BASE_URL มาจาก env (ค่าตั้งต้น http://localhost:3000)
 * - เว็บต้องเปิดด้วย TEST_MODE=1 · BUG_MODE ตั้งที่ฝั่งเว็บ ไม่ใช่ที่นี่
 */
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results',
  reporter: [
    ['list'],
    ['json', { outputFile: './test-results/results.json' }],
    ['html', { open: 'never', outputFolder: './playwright-report' }],
  ],
  use: {
    baseURL: BASE_URL,
    testIdAttribute: 'data-testid',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
});
