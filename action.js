// action.js (with finalUrl safe fallback)

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { URL } from 'url';
import { getSafeFolderPath } from './utils.js';

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
        resultHTML = result.resultHtml || '';
        finalUrl = result.finalUrl || url;
    } catch (err) {
        console.error('❌ Failed to execute AI actions:', err.message);
    }

    const safeUrl = finalUrl || url;
    const folder = getSafeFolderPath(safeUrl);
    fs.mkdirSync(folder, { recursive: true });

    const scriptFile = path.join(folder, `script_${timestamp}.cjs`);
    fs.writeFileSync(scriptFile, aiCode, 'utf8');

    if (resultHTML) {
        fs.writeFileSync(path.join(folder, 'result.html'), resultHTML, 'utf8');
    }

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

    const cookiePath = path.join(folder, 'cookies.json');
    if (fs.existsSync(cookiePath)) {
        cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
    }

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
    const safeUrl = contextData.url;
    const folder = getSafeFolderPath(safeUrl);

    fs.mkdirSync(folder, { recursive: true });

    const scriptFileName = `exec_script_${crypto.randomUUID().slice(0, 8)}.cjs`;
    const filePath = path.join(folder, scriptFileName);

    const filledScript = generateStandaloneScript(safeUrl, aiCode, contextData.vars);
    fs.writeFileSync(filePath, filledScript, 'utf8');

    let resultHtml = '';
    let finalUrl = contextData.url;

    try {
        const output = execSync(`node ${filePath}`, { encoding: 'utf8', timeout: 60000 });
        const resultPath = path.join(folder, 'final_result.json');
        if (fs.existsSync(resultPath)) {
            const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
            resultHtml = result.html;
            finalUrl = result.url || finalUrl;
        }
    } catch (err) {
        throw new Error(`AI script error: ${err.message}`);
    }

    return {
        navigationOccurred: !!finalUrl && finalUrl !== contextData.url,
        finalUrl,
        resultHtml
    };
}

function generateStandaloneScript(url, aiCode, vars) {
    const folder = getSafeFolderPath(url);

    return `const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');


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
    await page.waitForLoadState('networkidle');
    await new Promise(res => setTimeout(res, 3000));  // optional buffer
    try {
        ${aiCode}
    } catch (err) {
        console.error('❌ Error during AI script execution:', err.message);
    }

    await new Promise(res => setTimeout(res, 10000));
    const cookies = await context.cookies();
    const html = await page.content();
    const finalUrl = page.url();
    fs.writeFileSync(path.join("${folder.replace(/\\/g, '\\\\')}", 'cookies.json'), JSON.stringify(cookies, null, 2));
    fs.writeFileSync(path.join("${folder.replace(/\\/g, '\\\\')}", 'final_result.json'), JSON.stringify({ html, url: finalUrl }, null, 2));


    await browser.close();
})();
`;
}
