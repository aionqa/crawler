import { chromium } from 'playwright';
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
    const sessionId = crypto.randomUUID().slice(0, 8);
    const timestamp = Date.now();

    try {
        const result = await runAICodeSafely(aiCode, { vars, url });
        navigationOccurred = result.navigationOccurred || false;
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
        const videoDir = './tmp_videos';
        const videoFile = fs.readdirSync(videoDir)
            .map(f => path.join(videoDir, f))
            .filter(f => f.endsWith('.webm'))
            .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime)[0];

        if (videoFile) {
            finalVideoPath = path.join(folder, `video_${timestamp}.webm`);
            fs.renameSync(videoFile, finalVideoPath);
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
    const tempDir = './tmp_exec';
    fs.mkdirSync(tempDir, { recursive: true });

    const scriptFileName = `exec_script_${crypto.randomUUID().slice(0, 8)}.cjs`;
    const filePath = path.join(tempDir, scriptFileName);

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

  await new Promise(res => setTimeout(res, 2000)); // Let video finalize
  await browser.close();
})();
`;
}

