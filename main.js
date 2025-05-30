import { config } from 'dotenv';
import { analyzePageWithActions } from './ai.js';
import { runActionsOnPage } from './action.js';
import { crawlPageWithPlaywright } from './crawler.js';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';


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
            console.error(`❌ Invalid URL skipped: ${u}`);
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
const pagesLogPath = path.join('outcome', 'pages.txt');
fs.mkdirSync(path.dirname(pagesLogPath), { recursive: true });

function logVisited(url) {
    fs.appendFileSync(pagesLogPath, url + '\n');
}

// Updated main.js (only changes shown here; keep rest of the original script)

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
- If a field name or placeholder matches a key in 'vars', use that value in a page.fill().
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
            await crawlPage(finalUrl, updatedHeaders, domain); // <--- Always re-crawl finalUrl

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
${resultHTML.slice(0, 2000)}...`;
            const newCode = await analyzePageWithActions(
                {
                    url: finalUrl,
                    title: '',
                    content: actionResult.resultHTML,
                    links: [],
                    fields: [],
                },
                followUpPrompt
            );

            await runActionsOnPage(finalUrl, newCode, aiVars, APP_DEBUG);
        }

        // Continue with link crawling as before
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


async function main() {
    console.log(`🚀 Starting crawl for ${urls.length} URL(s)...`);
    for (const url of urls) {
        await crawlPage(url);
    }
    console.log(`✅ Crawling completed.`);
}

main();
