import { config } from 'dotenv';
import { analyzePageWithActions } from './ai.js';
import { runActionsOnPage } from './action.js';
import { crawlPageWithPlaywright } from './crawler.js';
import fs from 'fs';
import path from 'path';

config();

const APP_DEBUG = process.env.APP_DEBUG === 'true';
const urls = (process.env.TARGETS || '')
    .split(',')
    .map(u => u.trim())
    .filter(u => {
        try {
            new URL(u);
            return true;
        } catch {
            if (APP_DEBUG) console.error(`❌ Invalid URL skipped: ${u}`);
            return false;
        }
    });

let aiVars = {};
try {
    aiVars = JSON.parse(process.env.AI_VARS || '{}');
} catch {
    console.error('❌ Invalid AI_VARS JSON. Using empty object.');
}
const aiVarKeys = Object.keys(aiVars);

const visited = new Set();

async function crawlPage(url, headers = {}) {
    if (visited.has(url)) {
        if (APP_DEBUG) console.error(`🔁 Already visited: ${url}`);
        return;
    }
    visited.add(url);

    console.log(`🌐 Crawling: ${url}`);
    try {
        const result = await crawlPageWithPlaywright(url, headers);
        const { title, content, links, fields, screenshotPath } = result;

        if (!content || content.trim().length < 10) {
            console.error(`⚠️ Skipping ${url} due to insufficient content.`);
            return;
        }

        if (APP_DEBUG) {
            console.error(`📄 Title: ${title}`);
            console.error(`🔗 Links: ${links.length}`);
            console.error(`📦 Fields: ${fields.length}`);
        }

        const safeContent = content.slice(0, 2000);

        const crawl_prompt = `
You are an intelligent automation agent using Playwright.

Your task is to analyze a webpage and return only executable JavaScript code for Playwright that performs actions like filling in forms, clicking buttons, and waiting for results.

⚠️ You must:
- Do not use require(), import statements, or external modules.
- Use selectors to interact with form elements and buttons.
- Use provided variable keys if appropriate for field inputs.
- After submitting the form, you must wait and observe what happens — the outcome is unknown.
- You must detect or infer the result by analyzing page behavior, DOM changes, or network responses.
- You must **collect the result** after submission (e.g. visible message, status text, navigation result) and store or log it clearly.
- Handle multiple possible outcomes (e.g. success, error, redirect).
- Do not use eval, unnecessary browser logs, or hardcoded content.
- Output only valid, executable JavaScript code — no markdown, no explanations.
- do not set up any checks after submit, just let them finish whatever they do and stop

After each \`page.fill()\` or \`page.click()\`, add a small delay using:
    await new Promise(res => setTimeout(res, 500));
This ensures your actions are visible in recordings.

on every page try to scroll down for in equivalent of at least two pagedowns.

keys from object "vars" ${aiVarKeys.join(', ')}

Page Info:
- URL: ${url}
- Title: ${title}
- Total Links: ${links.length}
- Fields: ${JSON.stringify(fields.slice(0, 10), null, 2)}
- Visible Text Snippet:
${safeContent}
`;

        const aiCode = await analyzePageWithActions(
            { ...result, content: result.content || '' },
            crawl_prompt
        );
        if (APP_DEBUG) console.error(`🧠 AI-generated code:\n${aiCode}`);
        else console.log('🤖 AI Code received');

        const actionResult = await runActionsOnPage(url, aiCode, aiVars, APP_DEBUG);

        // Move screenshot into same folder
        if (result.screenshotPath && fs.existsSync(result.screenshotPath)) {
            const { protocol, hostname, pathname } = new URL(url);
            const safePath = pathname.replace(/[^a-z0-9]/gi, '_').slice(0, 50) || 'root';
            const folder = path.join('outcome', protocol.replace(':', ''), hostname, safePath);
            fs.mkdirSync(folder, { recursive: true });
            const screenshotTarget = path.join(folder, 'screenshot.png');
            fs.copyFileSync(result.screenshotPath, screenshotTarget);
        }

        const updatedHeaders = actionResult?.headers || headers;

        if (actionResult?.resultHTML) {
            const newPromptContext = {
                url: actionResult.resultUrl || url,
                title: '',
                content: actionResult.resultHTML,
                links: [],
                fields: [],
            };

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

            const newCode = await analyzePageWithActions(
                { ...newPromptContext, content: newPromptContext.content || '' },
                followUpPrompt
            );
            if (APP_DEBUG) console.error(`🧠 Follow-up AI code:\n${newCode}`);
            else console.log('🤖 Follow-up AI Code received');

            await runActionsOnPage(newPromptContext.url, newCode, aiVars, APP_DEBUG);
        }

        const nextLinks = (links || []).slice(0, 3);
        for (const link of nextLinks) {
            if (APP_DEBUG) console.error(`🔗 Queueing next link: ${link}`);
            await crawlPage(link, updatedHeaders);
        }
    } catch (err) {
        console.error(`❌ Error crawling ${url}:`, err.message);
    }
}

async function main() {
    if (APP_DEBUG) console.error(`🚀 Starting crawl for ${urls.length} URL(s)...`);
    for (const url of urls) {
        await crawlPage(url);
    }
    if (APP_DEBUG) console.error(`✅ Crawling completed.`);
}

main();
