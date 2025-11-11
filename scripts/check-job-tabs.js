import { chromium } from 'playwright';

async function run() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Usage: node scripts/check-job-tabs.js <jobId>');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const baseUrl = 'http://localhost:3000';

  page.on('console', (msg) => {
    console.log(`[browser:${msg.type()}] ${msg.text()}`);
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await page.fill('#email', 'tester12345@example.com');
    await page.fill('#password', 'Password123');
    await Promise.all([
      page.waitForURL('**/stats', { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);

    await page.goto(`${baseUrl}/logs/${jobId}`, { waitUntil: 'networkidle' });

    const tabSelectors = {
      chat: 'button.mode-tab:has-text("Chat")',
      logs: 'button.mode-tab:has-text("Logs")',
      vars: 'button.mode-tab:has-text("Var Dumps")',
      videos: 'button.mode-tab:has-text("Videos")',
    };

    await page.waitForSelector('.mode-tab', { timeout: 10000 });

    const counters = {
      chat: async () => {
        await page.waitForTimeout(2000);
        await page.waitForSelector('.cursor-chat-mode', { timeout: 10000 });
        await page.waitForTimeout(1500);
        return await page.locator('.conversation-group').count();
      },
      logs: async () => await page.locator('.log-entry').count(),
      vars: async () => await page.locator('.var-dump-card').count(),
      videos: async () => await page.locator('.videos-table tbody tr, .video-segments-column .segment-card').count(),
    };

    for (const [mode, selector] of Object.entries(tabSelectors)) {
      await page.click(selector);
      if (mode !== 'chat') {
        await page.waitForTimeout(1000);
      }
      const count = await counters[mode]();
      console.log(`${mode} tab item count: ${count}`);
    }
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error('Error while checking job tabs:', error);
  process.exit(1);
});

