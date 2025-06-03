import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { chromium } from 'playwright';
import { aiInteract } from './ai.js';
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
    const entry = { ...info, type };
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
}


export async function gatherPageInfo(page, url, folder) {
    ensureDir(folder);

    const screenshotPath = path.join(folder, "screenshot.jpg");
    console.log(`📸 Taking screenshot for: ${url}`);
    await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 60, fullPage: true });

    console.log(`🔍 Gathering DOM info for: ${url}`);
    const info = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => {
                try {
                    const u = new URL(href, location.href);
                    return u.pathname !== location.pathname || !u.hash || u.href.replace(u.hash, '') !== location.href.replace(location.hash, '');
                } catch { return false; }
            });

        function extractField(el) {
            return {
                tag: el.tagName.toLowerCase(),
                id: el.id || "",
                name: el.name || "",
                type: el.type || el.tagName.toLowerCase(),
                placeholder: el.placeholder || "",
                ariaLabel: el.getAttribute("aria-label") || "",
                value: el.value || "",
                outerHTML: el.outerHTML
            };
        }

        function extractButton(el) {
            return {
                tag: el.tagName.toLowerCase(),
                id: el.id || "",
                name: el.name || "",
                type: el.type || "button",
                text: el.innerText || el.value || "",
                ariaLabel: el.getAttribute("aria-label") || "",
                outerHTML: el.outerHTML
            };
        }

        const forms = Array.from(document.querySelectorAll("form")).map(form => ({
            type: "form",
            id: form.id || "",
            name: form.name || "",
            outerHTML: form.outerHTML,
            inputs: Array.from(form.querySelectorAll("input, textarea, select")).map(extractField),
            buttons: Array.from(form.querySelectorAll("button, input[type='submit'], input[type='button']")).map(extractButton)
        }));

        const pseudoForms = Array.from(document.querySelectorAll("div, section"))
            .filter(container => {
                const hasFields = container.querySelectorAll("input, textarea, select").length > 0;
                const hasButton = container.querySelectorAll("button, input[type='submit'], input[type='button']").length > 0;
                if (!hasFields || !hasButton) return false;
                for (const child of container.children) {
                    if (child !== container && child.querySelectorAll &&
                        child.querySelectorAll("input, textarea, select").length > 0 &&
                        child.querySelectorAll("button, input[type='submit'], input[type='button']").length > 0) return false;
                }
                return true;
            })
            .map(container => ({
                type: "pseudo-form",
                id: container.id || "",
                name: container.getAttribute("name") || "",
                outerHTML: container.outerHTML,
                inputs: Array.from(container.querySelectorAll("input, textarea, select")).map(extractField),
                buttons: Array.from(container.querySelectorAll("button, input[type='submit'], input[type='button']")).map(extractButton)
            }));

        const allForms = [...forms, ...pseudoForms];

        const interactives = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
            .filter(el => !el.closest('form'))
            .map(el => ({
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                name: el.name || null,
                type: el.type || 'button',
                text: el.innerText || el.value || null,
            }));

        const h1 = document.querySelector('h1')?.innerText || '';
        const h2 = document.querySelector('h2')?.innerText || '';
        const ps = Array.from(document.querySelectorAll('p')).map(p => p.innerText).join(' ');
        const text = [h1, h2, ps].join(' ').replace(/\s+/g, ' ').slice(0, 500);

        return { links, allForms, interactives, textSummary: text };
    });

    console.log(`🍪 Saving cookies for: ${url}`);
    const cookies = await page.context().cookies();
    fs.writeFileSync(path.join(folder, "cookies.json"), JSON.stringify(cookies, null, 2));
    fs.writeFileSync(path.join(folder, "info.json"), JSON.stringify(info, null, 2));
    // Inline same-origin iframe content before snapshot
    await page.evaluate(() => {
        document.querySelectorAll('iframe').forEach(iframe => {
            try {
                if (iframe.contentDocument && iframe.contentDocument.documentElement) {
                    const div = document.createElement('div');
                    div.innerHTML = iframe.contentDocument.documentElement.outerHTML;
                    div.setAttribute('data-inlined-iframe', 'true');
                    iframe.parentNode.replaceChild(div, iframe);
                }
            } catch (e) {
                // Ignore cross-origin
            }
        });
    });
    const currentHtml = await page.content();
    fs.writeFileSync(path.join(folder, `html_snapshot_${Date.now()}.html`), currentHtml, "utf8");
    const videoPath = path.join(folder, "video.webm");

    return {
        url, screenshotPath, videoPath, cookies,
        ...info,
        currentHtml
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
        console.log(`🌐 Crawling [depth ${depth}]: ${url}`);

        const pageId = Buffer.from(url).toString('base64').replace(/[/+=]/g, '');
        const folder = path.join(OUTPUT, pageId);
        ensureDir(folder);

        // ---- Always load cookies/storage state if exists ----
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

            let aiResult = null;

            if (pageData.allForms && pageData.allForms.length > 0) {
                const seenForms = new Set();
                for (const form of pageData.allForms) {
                    const key = form.inputs.map(i => i.name + i.type).join(',') + form.buttons.map(b => b.text).join(',');
                    if (seenForms.has(key)) continue;
                    seenForms.add(key);

                    console.log(`🤖 Passing form to AI for: ${url}`);
                    aiResult = await aiInteract({ ...pageData, form }, folder);
                    if (aiResult.error) {
                        console.log(`❌ AI interaction error: ${aiResult.error}`);
                    } else {
                        console.log(`✅ AI interaction complete for form on: ${url}`);
                    }

                    const resultHtml = aiResult.resultHtml || '';
                    const afterActionUrl = aiResult.afterActionUrl || url;
                    const htmlHash = resultHtml ? crypto.createHash('md5').update(resultHtml).digest('hex') : '';
                    const stateKey = afterActionUrl + '#' + htmlHash;

                    if (!seenStates.has(stateKey) &&
                        (afterActionUrl !== url || htmlSignificantlyChanged(originalHtml, resultHtml))) {
                        seenStates.add(stateKey);

                        const virtualPageId = Buffer.from(afterActionUrl + '_' + htmlHash).toString('base64').replace(/[/+=]/g, '');
                        const virtualFolder = path.join(OUTPUT, virtualPageId);
                        ensureDir(virtualFolder);
                        fs.writeFileSync(path.join(virtualFolder, "virtual_result.html"), resultHtml, "utf8");

                        const browser2 = await chromium.launch();
                        const context2 = await browser2.newContext(
                            fs.existsSync(storagePath) ? { storageState: storagePath } : {}
                        );
                        const page2 = await context2.newPage();
                        await page2.setContent(resultHtml, { waitUntil: 'domcontentloaded' });

                        const spaPageInfo = await gatherPageInfo(page2, afterActionUrl, virtualFolder);
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
                        }, "virtual");

                        const spaLinks = spaPageInfo.links?.filter(l => {
                            try {
                                const absUrl = new URL(l, baseDomain);
                                if (absUrl.origin !== baseDomain) return false;
                                if (absUrl.href === afterActionUrl) return false;
                                return !visited.has(absUrl.href);
                            } catch {
                                return false;
                            }
                        }) || [];

                        for (const l of spaLinks) {
                            if (!isUrlIgnored(l)) {
                                pagesToVisit.push({ url: l, depth: depth + 2 });
                            } else {
                                console.log(`⏩ Skipping ignored virtual link: ${l}`);
                            }
                        }

                        await page2.close();
                        await context2.close();
                        await browser2.close();
                    }

                    if (
                        afterActionUrl &&
                        afterActionUrl !== url &&
                        !visited.has(afterActionUrl)
                    ) {
                        if (!isUrlIgnored(afterActionUrl)) {
                            pagesToVisit.push({ url: afterActionUrl, depth: depth + 1 });
                        } else {
                            console.log(`⏩ Skipping ignored afterActionUrl: ${afterActionUrl}`);
                        }
                    }
                }
            } else {
                console.log(`🤖 Passing non-form page to AI for: ${url}`);
                aiResult = await aiInteract({ ...pageData, form: null }, folder);

                const resultHtml = aiResult.resultHtml || '';
                const afterActionUrl = aiResult.afterActionUrl || url;
                const htmlHash = resultHtml ? crypto.createHash('md5').update(resultHtml).digest('hex') : '';
                const stateKey = afterActionUrl + '#' + htmlHash;

                if (!seenStates.has(stateKey) &&
                    (afterActionUrl !== url || htmlSignificantlyChanged(originalHtml, resultHtml))) {
                    seenStates.add(stateKey);

                    const virtualPageId = Buffer.from(afterActionUrl + '_' + htmlHash).toString('base64').replace(/[/+=]/g, '');
                    const virtualFolder = path.join(OUTPUT, virtualPageId);
                    ensureDir(virtualFolder);
                    fs.writeFileSync(path.join(virtualFolder, "virtual_result.html"), resultHtml, "utf8");

                    const browser2 = await chromium.launch();
                    const context2 = await browser2.newContext(
                        fs.existsSync(storagePath) ? { storageState: storagePath } : {}
                    );
                    const page2 = await context2.newPage();
                    await page2.setContent(resultHtml, { waitUntil: 'domcontentloaded' });

                    const spaPageInfo = await gatherPageInfo(page2, afterActionUrl, virtualFolder);
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
                    }, "virtual");

                    const spaLinks = spaPageInfo.links?.filter(l => {
                        try {
                            const absUrl = new URL(l, baseDomain);
                            if (absUrl.origin !== baseDomain) return false;
                            if (absUrl.href === afterActionUrl) return false;
                            return !visited.has(absUrl.href);
                        } catch {
                            return false;
                        }
                    }) || [];

                    for (const l of spaLinks) {
                        if (!isUrlIgnored(l)) {
                            pagesToVisit.push({ url: l, depth: depth + 2 });
                        } else {
                            console.log(`⏩ Skipping ignored virtual link: ${l}`);
                        }
                    }

                    await page2.close();
                    await context2.close();
                    await browser2.close();
                }

                if (
                    aiResult.afterActionUrl &&
                    aiResult.afterActionUrl !== url &&
                    !visited.has(aiResult.afterActionUrl)
                ) {
                    pagesToVisit.push({ url: aiResult.afterActionUrl, depth: depth + 1 });
                }
            }

            let newLinks = pageData.links?.filter(l => {
                try {
                    const absUrl = new URL(l, baseDomain);
                    if (absUrl.origin !== baseDomain) return false;
                    if (absUrl.href === url) return false;
                    if (absUrl.hash && absUrl.origin + absUrl.pathname === new URL(url).origin + new URL(url).pathname) return false;
                    return !visited.has(absUrl.href);
                } catch {
                    return false;
                }
            }) || [];

            if (aiResult?.newUrls) {
                newLinks.push(...aiResult.newUrls.filter(l => {
                    try {
                        const u = new URL(l, baseDomain);
                        return u.origin === baseDomain && !visited.has(u.toString());
                    } catch { return false; }
                }));
            }

            for (const l of newLinks) {
                console.log(`➕ Enqueueing new link: ${l}`);
                if (!isUrlIgnored(l)) {
                    pagesToVisit.push({ url: l, depth: depth + 1 });
                } else {
                    console.log(`⏩ Skipping ignored new link: ${l}`);
                }
            }

            // ---- Always save storage/cookies after each context ----
            await context.storageState({ path: storagePath });

            const uuid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
            const title = await page.title();
            const formsCount = (pageData.allForms || []).length;
            const aiDid = aiResult?.summary || '';
            const stats = {
                forms: formsCount,
                ai_interaction: Boolean(aiDid),
                interactives: (pageData.interactives || []).length
            };
            logPage({
                url,
                uuid,
                summary: aiDid,
                title,
                statistics: stats
            });

        } catch (err) {
            console.warn(`⚠️ Error crawling ${url}: ${err.message}`);
        } finally {
            if (page && !await page.isClosed()) await page.close();
            await context.close();
            await browser.close();
            console.log(`🛑 Closed browser for: ${url}`);
        }
    }
    console.log(`🏁 Crawling complete!`);
    process.exit(0);
}

(async () => {
    await recursiveCrawl(DOMAIN, MAX_DEPTH);
})();
