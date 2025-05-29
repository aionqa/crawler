import { config } from 'dotenv';
import { analyzePageWithActions } from './ai.js';
import { runActionsOnPage } from './action.js';
import { crawlPageWithPlaywright } from './crawler.js';

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

        if (APP_DEBUG) {
            console.error(`📄 Title: ${result.title}`);
            console.error(`🔗 Links: ${result.links.length}`);
            console.error(`📦 Fields: ${result.fields.length}`);
        }
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

keys from object "vars" ${aiVarKeys.join(', ')}

Page Info:
- URL: ${url}
- Title: ${title}
- Total Links: ${links.length}
- Fields: ${JSON.stringify(fields.slice(0, 10), null, 2)}
- Content Snippet:
${content.slice(0, 1500)}
`;
        const aiCode = await analyzePageWithActions(result, crawl_prompt);
        if (APP_DEBUG) console.error(`🧠 AI-generated code:\n${aiCode}`);
        else console.log('🤖 AI Code received');

        const actionResult = await runActionsOnPage(url, aiCode, aiVars, APP_DEBUG);
        const updatedHeaders = actionResult?.headers || headers;

// ✨ NEW: If resultHTML exists, run second-stage analysis
        if (actionResult?.resultHTML) {
            const newPromptContext = {
                url: actionResult.resultUrl || url,
                title: '', // Optional: could re-capture this
                content: actionResult.resultHTML,
                links: [],
                fields: [],
            };

            const followUpPrompt = `
The following HTML was returned after submitting a form on the page.
Analyze this outcome and determine what action should be taken next, if any.
Use valid Playwright code and refer to 'vars' if input is needed.

Returned content:
${actionResult.resultHTML.slice(0, 2000)}...`;

            const newCode = await analyzePageWithActions({ ...newPromptContext, content: followUpPrompt });

            if (APP_DEBUG) console.error(`🧠 Follow-up AI code:\n${newCode}`);
            else console.log('🤖 Follow-up AI Code received');

            await runActionsOnPage(newPromptContext.url, newCode, aiVars, APP_DEBUG);
        }


        const nextLinks = (result.links || []).slice(0, 3);
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
