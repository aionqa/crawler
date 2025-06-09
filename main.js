// main.js
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { chromium } from 'playwright';
import { aiInteractRecursive } from './ai.js';
import { aiDescribePage } from './ai.js';
import { analyzeHtmlContent } from './htmlAnalyzer.js';
import crypto from 'crypto';

const DOMAIN = process.env.TARGETS || "https://practicetestautomation.com/practice-test-login/";
const OUTPUT = process.env.OUTPUT_FOLDER || "./outcome";
const MAX_DEPTH = Number(process.env.MAX_DEPTH) || 5;
const TARGETS_IGNORE = process.env.TARGETS_IGNORE
    ? process.env.TARGETS_IGNORE.split(',').map(s => s.trim()).filter(Boolean)
    : [];

function isUrlIgnored(url) {
    return TARGETS_IGNORE.some(pattern => url.includes(pattern));
}

function scopedLogger(id) {
    const originalLog = console.log;
    const originalWarn = console.warn;

    console.log = (...args) => originalLog(`[${id}]`, ...args);
    console.warn = (...args) => originalWarn(`[${id}] ⚠️`, ...args);

    return () => {
        console.log = originalLog;
        console.warn = originalWarn;
    };
}


function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📂 Created directory: ${dir}`);
    }
}
ensureDir(OUTPUT);

const storagePath = path.join(OUTPUT, "storage.json");

function logPage(info, type = "crawl") {
    const logFile = path.join(OUTPUT, "pages.txt");
    const uuid = info.uuid || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
    const entry = { ...info, uuid, type };
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

export async function gatherPageInfo(page, url, folder) {
    ensureDir(folder);

    const screenshotPath = path.join(folder, "screenshot.jpg");
    console.log(`📸 Taking screenshot for: ${url}`);
    await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 60, fullPage: true });

    console.log(`🔍 Gathering DOM info for: ${url}`);
    await page.evaluate(() => {
        document.querySelectorAll('iframe').forEach(iframe => {
            try {
                if (iframe.contentDocument && iframe.contentDocument.documentElement) {
                    const div = document.createElement('div');
                    div.innerHTML = iframe.contentDocument.documentElement.outerHTML;
                    div.setAttribute('data-inlined-iframe', 'true');
                    iframe.parentNode.replaceChild(div, iframe);
                }
            } catch { }
        });
    });

    const currentHtml = await page.content();
    const info = await analyzeHtmlContent(currentHtml, url);

    fs.writeFileSync(path.join(folder, `html_snapshot_${Date.now()}.html`), currentHtml, "utf8");

    console.log(`🍪 Saving cookies for: ${url}`);
    const cookies = await page.context().cookies();
    fs.writeFileSync(path.join(folder, "cookies.json"), JSON.stringify(cookies, null, 2));
    fs.writeFileSync(path.join(folder, "info.json"), JSON.stringify(info, null, 2));

    return {
        url, screenshotPath, cookies, currentHtml,
        ...info
    };
}

function htmlSignificantlyChanged(htmlA, htmlB) {
    if (!htmlA || !htmlB) return false;
    return htmlA.slice(0, 1000) !== htmlB.slice(0, 1000) ||
        htmlA.slice(-1000) !== htmlB.slice(-1000);
}

export async function recursiveCrawl(startUrl, maxDepth = MAX_DEPTH, visited = new Set(), seenStates = new Set()) {
    const baseDomain = new URL(startUrl).origin;
    let pagesToVisit = [{ url: startUrl, depth: 0 }];

    console.log(`🚀 Starting crawl at: ${startUrl}`);

    while (pagesToVisit.length) {
        const { url, depth } = pagesToVisit.shift();
        if (visited.has(url) || depth > maxDepth) continue;
        if (isUrlIgnored(url)) {
            console.log(`⏩ Skipping ignored URL: ${url}`);
            continue;
        }
        visited.add(url);

        const uuid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        const restoreLog = scopedLogger(uuid);
        const folder = path.join(OUTPUT, uuid);
        ensureDir(folder);

        console.log(`🌐 Crawling [depth ${depth}]: ${url}`);

        let contextOptions = {};
        if (fs.existsSync(storagePath)) {
            contextOptions.storageState = storagePath;
        }

        const browser = await chromium.launch();
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(10000);
            await page.waitForLoadState('domcontentloaded');

            const pageData = await gatherPageInfo(page, url, folder);
            const originalHtml = pageData.currentHtml;
            const allForms = pageData.allForms || [];
            let aiResult = null;
            let lastUrl = url;

            const seenForms = new Set();

            console.log(`🧾 Found ${allForms.length} form(s) on: ${url}`);
            allForms.forEach((form, index) => {
                const inputSummary = form.inputs.map(i => `${i.name || i.id || i.placeholder || i.type}`).join(', ');
                const buttonSummary = form.buttons.map(b => b.text || b.name || b.id).join(', ');
                console.log(`   #${index + 1}: inputs: [${inputSummary}] | buttons: [${buttonSummary}]`);
            });

            await context.storageState({ path: storagePath });
            console.log(`🍪 Saved before-forms cookies for: ${url}`);

            for (const form of allForms) {
                const key = form.inputs.map(i => i.name + i.type).join(',') + form.buttons.map(b => b.text).join(',');
                if (seenForms.has(key)) continue;
                seenForms.add(key);



                console.log(`🤖 Passing form to AI for: ${url}`);
                aiResult = await aiInteractRecursive({ ...pageData, form }, folder);

                const resultHtml = aiResult?.resultHtml || '';
                const afterActionUrl = aiResult?.afterActionUrl || url;
                const htmlHash = crypto.createHash('md5').update(resultHtml).digest('hex');
                const stateKey = afterActionUrl + '#' + htmlHash;

                //console.log("📌 Form container preview:", form.container.outerHTML.slice(0, 200));


                // Only continue if URL changed or DOM changed
                if (
                    !seenStates.has(stateKey) &&
                    (afterActionUrl !== url || htmlSignificantlyChanged(originalHtml, resultHtml))
                ) {
                    seenStates.add(stateKey);

                    const virtualPageId = Buffer.from(afterActionUrl + '_' + htmlHash).toString('base64').replace(/[/+=]/g, '');
                    const virtualFolder = path.join(OUTPUT, virtualPageId);
                    ensureDir(virtualFolder);
                    fs.writeFileSync(path.join(virtualFolder, "virtual_result.html"), resultHtml, "utf8");

                    const spaPageInfo = await analyzeHtmlContent(resultHtml, afterActionUrl);

                    logPage({
                        url: afterActionUrl,
                        uuid: virtualPageId,
                        summary: aiResult?.summary || "",
                        title: spaPageInfo?.title || "",
                        statistics: {
                            forms: (spaPageInfo?.allForms || []).length,
                            ai_interaction: true,
                            interactives: (spaPageInfo?.interactives || []).length
                        }
                    });

                    // Push links to crawl
                    const spaLinks = spaPageInfo.links || [];
                    for (const l of spaLinks) {
                        if (!isUrlIgnored(l)) {
                            pagesToVisit.push({ url: l, depth: depth + 2 });
                        }
                    }

                    if (!visited.has(afterActionUrl)) {
                        pagesToVisit.push({ url: afterActionUrl, depth: depth + 1 });
                    }

                    lastUrl = afterActionUrl;
                }
            }

            // If no forms or AI skipped, describe the page
            if (!aiResult && allForms.length === 0) {
                console.log(`🧠 Describing non-form page using AI: ${url}`);
                const description = await aiDescribePage({ ...pageData, form: null }, folder);

                if (description) {
                    fs.writeFileSync(path.join(folder, "page_description.txt"), description, "utf8");
                    logPage({
                        url,
                        uuid,
                        summary: "Described without interaction",
                        title: await page.title(),
                        statistics: {
                            forms: allForms.length,
                            ai_interaction: false,
                            interactives: (pageData.interactives || []).length
                        }
                    });
                }
            }

            // Gather new links to crawl
            const newLinks = (pageData.links || []).filter(link => {
                try {
                    const absUrl = new URL(link, baseDomain);
                    return (
                        absUrl.origin === baseDomain &&
                        absUrl.href !== url &&
                        !visited.has(absUrl.href) &&
                        !(absUrl.hash && absUrl.origin + absUrl.pathname === new URL(url).origin + new URL(url).pathname)
                    );
                } catch {
                    return false;
                }
            });

            for (const link of newLinks) {
                if (!isUrlIgnored(link)) {
                    pagesToVisit.push({ url: link, depth: depth + 1 });
                }
            }

            const title = await page.title();
            const stats = {
                forms: allForms.length,
                ai_interaction: Boolean(aiResult?.summary),
                interactives: (pageData.interactives || []).length
            };

            logPage({ url, uuid, summary: aiResult?.summary || "", title, statistics: stats });

        } catch (err) {
            console.warn(`⚠️ Error crawling ${url}: ${err.message}`);
        } finally {
            if (page && !await page.isClosed()) await page.close();
            await context.close();
            await browser.close();
            console.log(`🛑 Closed browser for: ${url}`);
            restoreLog();
        }
    }

    console.log(`🏁 Crawling complete!`);
    process.exit(0);
}

(async () => {
    await recursiveCrawl(DOMAIN, MAX_DEPTH);
})();
