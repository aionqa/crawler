import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export async function runActionsOnPage(url, aiCode, vars = {}, debug = false) {
    if (!aiCode || typeof aiCode !== 'string') return null;

    const videoDir = './videos';
    fs.mkdirSync(videoDir, { recursive: true });

    const sessionId = crypto.randomUUID().slice(0, 8);
    const safeName = url.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 100);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        recordVideo: {
            dir: videoDir,
            size: { width: 1920, height: 1080 }
        }
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    let resultHTML = '';
    let navigationOccurred = false;

    try {
        const result = await runAICodeSafely(aiCode, { page, vars, url });
        navigationOccurred = result.navigationOccurred || false;
        resultHTML = await page.content();
    } catch (err) {
        console.error('❌ Failed to execute AI actions:', err.message);
    }

    const cookies = await context.cookies();
    const finalUrl = page.url();

    await context.close();
    await browser.close();

    const tempVideoPath = fs.readdirSync(videoDir)
        .map(f => path.join(videoDir, f))
        .filter(f => f.endsWith('.webm'))
        .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime)[0];

    const newVideoPath = path.join(videoDir, `session_${safeName}_${sessionId}.webm`);
    if (tempVideoPath) {
        fs.renameSync(tempVideoPath, newVideoPath);
        console.log(`🎥 Video saved: ${newVideoPath}`);
    }

    const tokenCookie = cookies.find(c => c.name.toLowerCase().includes('token'));
    const headers = tokenCookie ? { Authorization: `Bearer ${tokenCookie.value}` } : null;

    return {
        headers,
        resultUrl: navigationOccurred ? finalUrl : null,
        resultHTML
    };
}


async function runAICodeSafely(aiCode, contextData) {
    const tempDir = './debug';
    fs.mkdirSync(tempDir, { recursive: true });

    const scriptFileName = `exec_script_${crypto.randomUUID().slice(0, 8)}.cjs`;
    const filePath = path.join(tempDir, scriptFileName);

    if (!contextData.url) {
        throw new Error('Missing URL for AI script execution.');
    }

    const filledScript = generateStandaloneScript(contextData.url, aiCode, contextData.vars);
    fs.writeFileSync(filePath, filledScript, 'utf8');

    try {
        execSync(`node ${filePath}`, { stdio: 'inherit', timeout: 20000 });
    } catch (err) {
        throw new Error(`AI script error: ${err.message}`);
    }

    return { navigationOccurred: false }; // Optional enhancement
}

function generateStandaloneScript(url, aiCode, vars) {
    return `// Auto-generated Playwright script
const { chromium } = require('playwright');

const vars = ${JSON.stringify(vars, null, 2)};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('${url}', { waitUntil: 'domcontentloaded' });

  try {
    ${aiCode}
  } catch (err) {
    console.error('❌ Error during AI script execution:', err.message);
  }

  await browser.close();
})();
`;
}
