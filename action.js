import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import vm from 'vm';

export async function runActionsOnPage(url, aiCode, vars = {}, debug = false) {
    if (!aiCode || typeof aiCode !== 'string') return null;

    const videoDir = './videos';
    fs.mkdirSync(videoDir, { recursive: true });

    const sessionId = crypto.randomUUID().slice(0, 8);
    const safeName = url.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 100);

    if (debug) {
        const debugDir = './debug';
        fs.mkdirSync(debugDir, { recursive: true });

        const filePath = path.join(debugDir, `debug_${safeName}_${sessionId}.js`);
        const content = generateDebugScript(url, aiCode, vars);
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`🐞 Debug script saved: ${filePath}`);
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        recordVideo: {
            dir: videoDir,
            size: { width: 1920, height: 1080 }
        }
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    let navigationOccurred = false;

    try {
        const result = await runAICodeSafely(aiCode, { page, vars });
        navigationOccurred = result.navigationOccurred || false;
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
        resultUrl: navigationOccurred ? finalUrl : null
    };
}

async function runAICodeSafely(aiCode, contextData) {
    const sandbox = {
        page: contextData.page,
        vars: contextData.vars,
        console,
        navigationOccurred: false
    };

    const script = new vm.Script(`(async () => { ${aiCode} })()`);
    const context = vm.createContext(sandbox);

    try {
        await script.runInContext(context, { timeout: 15000 });
    } catch (err) {
        throw new Error(`AI script error: ${err.message}`);
    }

    return { navigationOccurred: context.navigationOccurred };
}

function generateDebugScript(url, aiCode, vars) {
    return `// Auto-generated Playwright debug script
import { chromium } from 'playwright';

const vars = ${JSON.stringify(vars, null, 2)};

(async () => {
  const browser = await chromium.launch({ headless: false });
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
