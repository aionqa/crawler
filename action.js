import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { URL } from 'url';

export async function runActionsOnPage(url, aiCode, vars = {}, debug = false) {
    if (!aiCode || typeof aiCode !== 'string') return null;

    let resultHTML = '';
    let navigationOccurred = false;
    let cookies = [];
    let finalUrl = url;
    const timestamp = Date.now();

    try {
        const result = await runAICodeSafely(aiCode, { vars, url });
        navigationOccurred = result.navigationOccurred || false;
        // 🧁 Load cookies from file if they exist
        const { protocol, hostname, pathname } = new URL(url);
        const safePath = pathname.replace(/[^a-z0-9]/gi, '_').slice(0, 50) || 'root';
        const folder = path.join('outcome', protocol.replace(':', ''), hostname, safePath);

        const cookiePath = path.join(folder, 'cookies.json');
        if (fs.existsSync(cookiePath)) {
            cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
        }
    } catch (err) {
        console.error('❌ Failed to execute AI actions:', err.message);
    }


    // Extract path for structured output
    const { protocol, hostname, pathname } = new URL(url);
    const safePath = pathname.replace(/[^a-z0-9]/gi, '_').slice(0, 50) || 'root';
    const folder = path.join('outcome', protocol.replace(':', ''), hostname, safePath);
    fs.mkdirSync(folder, { recursive: true });

    // Save AI script
    const scriptFile = path.join(folder, `script_${timestamp}.cjs`);
    fs.writeFileSync(scriptFile, aiCode, 'utf8');

    // Save HTML result
    if (resultHTML) {
        fs.writeFileSync(path.join(folder, 'result.html'), resultHTML, 'utf8');
    }

    // Move and rename video
    let finalVideoPath = null;
    try {
        const expectedVideo = path.join(folder, 'playwright-video.webm');
        if (fs.existsSync(expectedVideo)) {
            finalVideoPath = path.join(folder, `video_${timestamp}.webm`);
            fs.renameSync(expectedVideo, finalVideoPath);
            console.log(`🎥 Video saved: ${finalVideoPath}`);
        }
    } catch (e) {
        if (debug) console.error('⚠️ Could not move video file:', e.message);
    }

    // Save debug info
    const tokenCookie = cookies.find(c => c.name.toLowerCase().includes('token'));
    const headers = tokenCookie ? { Authorization: `Bearer ${tokenCookie.value}` } : null;

    const debugData = {
        originalUrl: url,
        finalUrl,
        headers,
        cookies,
        scriptFile: path.basename(scriptFile),
        resultHtml: resultHTML ? 'result.html' : null,
        video: finalVideoPath ? path.basename(finalVideoPath) : null,
        timestamp
    };

    fs.writeFileSync(path.join(folder, 'debug.json'), JSON.stringify(debugData, null, 2));

    return {
        headers,
        resultUrl: navigationOccurred ? finalUrl : null,
        resultHTML
    };
}

async function runAICodeSafely(aiCode, contextData) {
    const { protocol, hostname, pathname } = new URL(contextData.url);
    const safePath = pathname.replace(/[^a-z0-9]/gi, '_').slice(0, 50) || 'root';
    const folder = path.join('outcome', protocol.replace(':', ''), hostname, safePath);
    fs.mkdirSync(folder, { recursive: true });

    const scriptFileName = `exec_script_${crypto.randomUUID().slice(0, 8)}.cjs`;
    const filePath = path.join(folder, scriptFileName);

    if (!contextData.url) {
        throw new Error('Missing URL for AI script execution.');
    }

    const filledScript = generateStandaloneScript(contextData.url, aiCode, contextData.vars);
    fs.writeFileSync(filePath, filledScript, 'utf8');

    try {
        execSync(`node ${filePath}`, { stdio: 'inherit', timeout: 60000 });
    } catch (err) {
        throw new Error(`AI script error: ${err.message}`);
    }

    return { navigationOccurred: false };
}

function generateStandaloneScript(url, aiCode, vars) {
    const { protocol, hostname, pathname } = new URL(url);
    const safePath = pathname.replace(/[^a-z0-9]/gi, '_').slice(0, 50) || 'root';
    const folder = path.join('outcome', protocol.replace(':', ''), hostname, safePath);
    if (!aiCode.includes('vars.')) {
        console.warn('⚠️ AI code does not reference any vars. Form may not be filled properly.');
    }
    else {
        console.log("🧪 Form variables:", vars);
    }
    return `// Auto-generated Playwright script
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

fs.mkdirSync("${folder}", { recursive: true });

const vars = ${JSON.stringify(vars, null, 2)};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordVideo: {
        dir: '${folder.replace(/\\/g, '\\\\')}',
        size: { width: 1280, height: 720 }
    }
  });
  const page = await context.newPage();
  await page.goto('${url}', { waitUntil: 'domcontentloaded' });

  try {
    ${aiCode}
  } catch (err) {
    console.error('❌ Error during AI script execution:', err.message);
  }

  await new Promise(res => setTimeout(res, 10000)); // Let video finalize
  const cookies = await context.cookies();
  fs.writeFileSync(path.join("${folder}", 'cookies.json'), JSON.stringify(cookies, null, 2));

  await browser.close();
})();
`;
}

