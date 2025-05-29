// main.js
import { config } from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { analyzePageWithActions } from './ai.js';
import { runActionsOnPage } from './action.js';

config(); // Load .env

const DEBUG = process.env.DEBUG === 'true';
const execFileAsync = promisify(execFile);
const urls = process.env.TARGETS?.split(',').map(u => u.trim()) || [];
const aiVars = JSON.parse(process.env.AI_VARS || '{}');

const visited = new Set();

async function crawlPage(url, headers = {}) {
    if (visited.has(url)) {
        if (DEBUG) console.error(`🔁 Skipping already visited: ${url}`);
        return;
    }
    visited.add(url);

    console.log(`🌐 Crawling: ${url}`);
    try {
        if (DEBUG) console.error(`📥 Running crawler.js with headers:`, headers);
        const { stdout } = await execFileAsync('node', [
            'crawler.js',
            '--url', url,
            '--headers', JSON.stringify(headers)
        ]);

        if (DEBUG) console.error(`✅ Crawler output received. Parsing JSON...`);
        const result = JSON.parse(stdout);

        if (DEBUG) {
            console.error(`📄 Page title: ${result.title}`);
            console.error(`🔗 Links found: ${result.links?.length || 0}`);
            console.error(`📦 Fields found: ${result.fields?.length || 0}`);
        }

        const aiCode = await analyzePageWithActions(result);
        if (DEBUG) console.error(`🧠 AI-generated code:\n${aiCode}`);
        else console.log('🤖 AI Code received');

        const actionResult = await runActionsOnPage(url, aiCode, aiVars, DEBUG);
        const updatedHeaders = actionResult?.headers || headers;

        if (actionResult?.resultUrl) {
            console.log(`🔁 Analyzing result page: ${actionResult.resultUrl}`);
            await crawlPage(actionResult.resultUrl, updatedHeaders);
        }

        const nextLinks = result.links?.slice(0, 3) || [];
        for (const link of nextLinks) {
            if (DEBUG) console.error(`🔗 Queueing next link: ${link}`);
            await crawlPage(link, updatedHeaders);
        }
    } catch (err) {
        console.error(`❌ Error crawling ${url}:`, err.stderr || err.message);
    }
}

async function main() {
    if (DEBUG) console.error(`🚀 Starting crawl for ${urls.length} URL(s)...`);
    for (const url of urls) {
        await crawlPage(url);
    }
    if (DEBUG) console.error(`✅ Crawling completed.`);
}

main();
