import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { chromium } from 'playwright';
import { aiInteract } from './ai.js';

const DOMAIN = process.env.TARGETS || "https://practicetestautomation.com/practice-test-login/";
const OUTPUT = process.env.OUTPUT_FOLDER || "./outcome";
const MAX_DEPTH = Number(process.env.MAX_DEPTH) || 5;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📂 Created directory: ${dir}`);
    }
}
ensureDir(OUTPUT);

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
    const currentHtml = await page.content();
    fs.writeFileSync(path.join(folder, `html_snapshot_${Date.now()}.html`), currentHtml, "utf8");
    const videoPath = path.join(folder, "video.webm");

    return {
        url, screenshotPath, videoPath, cookies,
        ...info
    };
}

export async function recursiveCrawl(startUrl, maxDepth = MAX_DEPTH, visited = new Set()) {
    const baseDomain = new URL(startUrl).origin;
    let pagesToVisit = [{ url: startUrl, depth: 0 }];
    console.log(`🚀 Starting crawl at: ${startUrl}`);

    while (pagesToVisit.length) {
        const { url, depth } = pagesToVisit.shift();
        if (visited.has(url) || depth > maxDepth) continue;
        visited.add(url);
        console.log(`🌐 Crawling [depth ${depth}]: ${url}`);

        const pageId = Buffer.from(url).toString('base64').replace(/[/+=]/g, '');
        const folder = path.join(OUTPUT, pageId);
        ensureDir(folder);

        const browser = await chromium.launch();
        const context = await browser.newContext({ recordVideo: { dir: folder, size: { width: 1280, height: 720 } } });
        const page = await context.newPage();

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1000);
            await page.waitForLoadState('domcontentloaded');

            const pageData = await gatherPageInfo(page, url, folder);

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
                }
            } else {
                console.log(`🤖 Passing non-form page to AI for: ${url}`);
                aiResult = await aiInteract({ ...pageData, form: null }, folder);
                if (aiResult.error) {
                    console.log(`❌ AI interaction error: ${aiResult.error}`);
                } else {
                    console.log(`✅ AI interaction complete for page: ${url}`);
                }
            }

            if (
                aiResult.afterActionUrl &&
                aiResult.afterActionUrl !== url &&
                !visited.has(aiResult.afterActionUrl)
            ) {
                const cookiesPath = path.join(folder, "after_cookies.json");
                let cookies = [];
                if (fs.existsSync(cookiesPath)) {
                    cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
                }
                pagesToVisit.push({ url: aiResult.afterActionUrl, depth: depth + 1, cookies });
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
                pagesToVisit.push({ url: l, depth: depth + 1 });
            }

        } catch (err) {
            console.warn(`⚠️ Error crawling ${url}: ${err.message}`);
        } finally {
            if (page && !page.isClosed()) await page.close();
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
