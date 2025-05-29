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

        const aiCode = await analyzePageWithActions(result);
        if (APP_DEBUG) console.error(`🧠 AI-generated code:\n${aiCode}`);
        else console.log('🤖 AI Code received');

        const actionResult = await runActionsOnPage(url, aiCode, aiVars, APP_DEBUG);
        const updatedHeaders = actionResult?.headers || headers;

        if (actionResult?.resultUrl) {
            console.log(`🔁 Analyzing result page: ${actionResult.resultUrl}`);
            await crawlPage(actionResult.resultUrl, updatedHeaders);
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
