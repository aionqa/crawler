import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import crypto from "crypto";
import { execSync } from "child_process";
import { log, PlaywrightCrawler } from "crawlee";
import OpenAI from "openai";

dotenv.config();

const APP_DEBUG = process.env.APP_DEBUG === 'true';
const urls = (process.env.TARGETS || '')
    .split(',')
    .map(u => u.trim())
    .filter(u => {
        try {
            new URL(u);
            return true;
        } catch {
            console.error(`❌ Invalid URL skipped: ${u}`);
            return false;
        }
    });

const DEBUG_LEVEL = process.env.DEBUG_LEVEL;
log.setLevel(DEBUG_LEVEL);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let aiVars = {};
try {
    aiVars = JSON.parse(process.env.AI_VARS || '{}');
} catch (err) {
    console.error('❌ Failed to parse AI_VARS from .env:', err.message);
}
const aiVarKeys = Object.keys(aiVars);

const visited = new Set();
const pagesLogPath = path.join('outcome', 'pages.txt');
fs.mkdirSync(path.dirname(pagesLogPath), { recursive: true });

function logVisited(url) {
    fs.appendFileSync(pagesLogPath, url + '\n');
}

async function crawlPage(url, headers = {}, domain = null) {
    const normalizedUrl = new URL(url).toString();
    if (visited.has(normalizedUrl)) {
        if (APP_DEBUG) console.error(`🔁 Already visited: ${normalizedUrl}`);
        return;
    }
    visited.add(normalizedUrl);
    logVisited(normalizedUrl);

    if (!domain) domain = new URL(url).origin;

    console.log(`🌐 Crawling: ${normalizedUrl}`);
    try {
        const result = await crawlPageWithPlaywright(normalizedUrl, headers);
        const { title, content, links, fields, screenshotPath } = result;

        if (!content || content.trim().length < 10) {
            console.error(`⚠️ Skipping ${normalizedUrl} due to insufficient content.`);
            return;
        }

        console.error(`📄 Title: ${title}`);
        console.error(`🔗 Links: ${links.length}`);
        console.error(`📦 Fields: ${fields.length}`);

        const safeContent = content.slice(0, 2000);

        const crawl_prompt = `
You are an intelligent automation agent using Playwright.

Your task is to analyze a webpage and return only executable JavaScript code for Playwright that performs actions like filling in forms, clicking buttons, and waiting for results.

⚠️ You must:
- Do not use require(), import statements, or external modules.
- DO NOT include require(), browser launch, or context creation code.
- Assume you have access to 'page' and 'vars'.
- Use selectors to interact with form elements and buttons.
- Use provided variable keys if appropriate for field inputs.
- You must use the values in the 'vars' object to fill in any relevant form fields.
- After submitting the form, you must wait and observe what happens — the outcome is unknown.
- You must detect or infer the result by analyzing page behavior, DOM changes, or network responses.
- You must **collect the result** after submission (e.g. visible message, status text, navigation result) and store or log it clearly.
- Handle multiple possible outcomes (e.g. success, error, redirect).
- Do not use eval, unnecessary browser logs, or hardcoded content.
- Output only valid, executable JavaScript code — no markdown, no explanations.
- do not set up any checks after submit, just let them finish whatever they do and stop

After each \`page.fill()\` or \`page.click()\`, add a small delay using:
    await new Promise(res => setTimeout(res, 500));

On every page try to scroll down for the equivalent of at least two pagedowns.

Keys from object "vars": ${aiVarKeys.join(', ')}

Page Info:
- URL: ${url}
- Title: ${title}
- Total Links: ${links.length}
- Fields: ${JSON.stringify(fields.slice(0, 10), null, 2)}
- Visible Text Snippet:
${safeContent}
`;

        const aiCode = await analyzePageWithActions(result, crawl_prompt);
        if (APP_DEBUG) console.error(`🧠 AI-generated code:\n${aiCode}`);

        const actionResult = await runActionsOnPage(normalizedUrl, aiCode, aiVars, APP_DEBUG);
        const updatedHeaders = actionResult?.headers || headers;
        const finalUrl = actionResult?.resultUrl || normalizedUrl;

        if (actionResult?.resultHTML) {
            await crawlPage(finalUrl, updatedHeaders, domain);

            const followUpPrompt = `
The following HTML was returned after submitting a form on the page.
Analyze this outcome and determine what action should be taken next, if any.
Use valid Playwright code and refer to 'vars' if input is needed.

⚠️ You must:
- Do not use require(), import statements, or external modules.
- Use selectors to interact with form elements and buttons.
- You must **collect the result** after submission (e.g. visible message, status text, navigation result) and store or log it clearly.
- Do not use eval, unnecessary browser logs, or hardcoded content.
- Output only valid, executable JavaScript code — no markdown, no explanations.

Returned content:
${actionResult.resultHTML.slice(0, 2000)}...`;

            const newCode = await analyzePageWithActions({
                url: finalUrl,
                title: '',
                content: actionResult.resultHTML,
                links: [],
                fields: [],
            }, followUpPrompt);

            await runActionsOnPage(finalUrl, newCode, aiVars, APP_DEBUG);
        }

        for (const link of links || []) {
            try {
                const absoluteUrl = new URL(link, normalizedUrl);
                if (absoluteUrl.origin === domain) {
                    await crawlPage(absoluteUrl.toString(), updatedHeaders, domain);
                }
            } catch (e) {
                if (APP_DEBUG) console.error(`❌ Invalid link skipped: ${link}`);
            }
        }
    } catch (err) {
        console.error(`❌ Error crawling ${normalizedUrl}:`, err.message);
    }
}

async function runActionsOnPage(url, aiCode, vars = {}, debug = false) {
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
        execSync(`node ${filePath}`, { encoding: 'utf8', timeout: 60000 });
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
    await new Promise(res => setTimeout(res, 3000));
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

async function analyzePageWithActions({ url, title, content, links, fields }, prompt) {
    const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
    });

    const message = completion.choices[0].message.content.trim();

    if (message.includes('```') || message.toLowerCase().startsWith('javascript')) {
        return message
            .replace(/```(js|javascript)?/gi, '')
            .replace(/^javascript\s*/i, '')
            .trim();
    }

    return message;
}

async function crawlPageWithPlaywright(startUrl, headers = {}) {
    const result = {
        url: startUrl,
        title: '',
        content: '',
        links: [],
        fields: [],
        screenshotPath: null
    };

    const crawler = new PlaywrightCrawler({
        async requestHandler({ page, request }) {
            if (headers && typeof headers === 'object') {
                await page.setExtraHTTPHeaders(headers);
            }

            await page.goto(request.url, { waitUntil: 'domcontentloaded' });

            const folder = getSafeFolderPath(startUrl);
            fs.mkdirSync(folder, { recursive: true });

            const screenshotPath = path.join(folder, 'screenshot.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });

            result.screenshotPath = screenshotPath;
            result.title = await page.title();
            result.content = await page.evaluate(() => document.body.innerText || '');
            result.links = await page.$$eval('a', as => as.map(a => a.href));

            result.fields = await page.evaluate(() => {
                function getDotDomPath(el) {
                    const path = [];
                    while (el && el.nodeName.toLowerCase() !== 'html') {
                        let segment = el.nodeName.toLowerCase();
                        if (el.id) segment += `#${el.id}`;
                        else if (el.className) {
                            const cls = el.className.trim().split(/\s+/).join('.');
                            if (cls) segment += `.${cls}`;
                        }
                        path.unshift(segment);
                        el = el.parentElement;
                    }
                    path.unshift('html');
                    return path.join('.');
                }

                const elements = document.querySelectorAll('input, textarea, select, button');
                return Array.from(elements).map(el => {
                    const tag = el.tagName.toLowerCase();
                    const type = el.getAttribute('type') || tag;
                    const name = el.name || el.id || el.placeholder || el.innerText || el.value || '';
                    return {
                        domPath: getDotDomPath(el),
                        name: name.trim(),
                        type: type.toLowerCase()
                    };
                });
            });
        }
    });

    await crawler.run([startUrl]);
    return result;
}

function getSafeFolderPath(urlStr) {
    const { protocol, hostname, pathname } = new URL(urlStr);
    const parts = [protocol.replace(':', ''), hostname, ...pathname.split('/').filter(Boolean)];
    const safeParts = parts.map(p => p.replace(/[^a-z0-9]/gi, '_').toLowerCase());
    return path.join('outcome', ...safeParts);
}

async function main() {
    console.log(`🚀 Starting crawl for ${urls.length} URL(s)...`);
    for (const url of urls) {
        await crawlPage(url);
    }
    console.log(`✅ Crawling completed.`);
}

main().catch(err => {
    console.error('❌ Fatal error in main():', err);
    process.exit(1);
});
