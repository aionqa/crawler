import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { chromium } from 'playwright';
import { aiInteract } from './ai.js';

// --- Config ---
const DOMAIN = process.env.TARGETS || "https://practicetestautomation.com/practice-test-login/";
const OUTPUT = process.env.OUTPUT_FOLDER || "./outcome";
const MAX_DEPTH = Number(process.env.MAX_DEPTH) || 5;

// --- Storage helpers ---
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(OUTPUT);

// --- PAGE INFO GATHERING ---
export async function gatherPageInfo(page, url, folder) {
    ensureDir(folder);

    // Video
    const context = page.context();
    const videoPath = path.join(folder, "video.webm");
    context.on('page', async (pg) => {
        pg.on('video', vid => vid.saveAs(videoPath));
    });

    // Screenshot
    const screenshotPath = path.join(folder, "screenshot.jpg");
    await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 60, fullPage: true });

    // Links, forms, interactives, summary text
    const info = await page.evaluate(() => {
        // Get all links (absolute)
        const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => {
                // Skip if href is just a hash or same-page anchor
                try {
                    const u = new URL(href, location.href);
                    // Remove if same path and only the hash changes
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
                // At least one input and one button, and is a "leaf"
                const hasFields = container.querySelectorAll("input, textarea, select").length > 0;
                const hasButton = container.querySelectorAll("button, input[type='submit'], input[type='button']").length > 0;
                if (!hasFields || !hasButton) return false;
                for (const child of container.children) {
                    if (
                        child !== container &&
                        child.querySelectorAll &&
                        child.querySelectorAll("input, textarea, select").length > 0 &&
                        child.querySelectorAll("button, input[type='submit'], input[type='button']").length > 0
                    ) return false;
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



        // Get interactives: buttons, inputs, etc. outside forms
        const interactives = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
            .filter(el => !el.closest('form'))
            .map(el => ({
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                name: el.name || null,
                type: el.type || 'button',
                text: el.innerText || el.value || null,
            }));

        // Text summary: h1, h2, p, 1st 500 chars
        const h1 = document.querySelector('h1')?.innerText || '';
        const h2 = document.querySelector('h2')?.innerText || '';
        const ps = Array.from(document.querySelectorAll('p')).map(p => p.innerText).join(' ');
        const text = [h1, h2, ps].join(' ').replace(/\s+/g, ' ').slice(0, 500);

        return { links, allForms , interactives, textSummary: text };
    });

    // Cookies
    const cookies = await page.context().cookies();
    fs.writeFileSync(path.join(folder, "cookies.json"), JSON.stringify(cookies, null, 2));

    // Save info
    fs.writeFileSync(path.join(folder, "info.json"), JSON.stringify(info, null, 2));
    return {
        url, screenshotPath, videoPath, cookies,
        ...info
    };
}

// --- RECURSIVE DOMAIN CRAWLER ---
export async function recursiveCrawl(startUrl, maxDepth = MAX_DEPTH, visited = new Set()) {
    const baseDomain = new URL(startUrl).origin;
    let pagesToVisit = [{ url: startUrl, depth: 0 }];

    while (pagesToVisit.length) {
        const { url, depth } = pagesToVisit.shift();
        if (visited.has(url) || depth > maxDepth) continue;
        visited.add(url);
        console.log(`Crawling [${depth}]:`, url);

        // Folder per page
        const pageId = Buffer.from(url).toString('base64').replace(/[/+=]/g, '');
        const folder = path.join(OUTPUT, pageId);
        ensureDir(folder);

        // Playwright browser/context for video
        const browser = await chromium.launch();
        const context = await browser.newContext({ recordVideo: { dir: folder, size: { width: 1280, height: 720 } } });
        const page = await context.newPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1500);

            const pageData = await gatherPageInfo(page, url, folder);

            if (pageData.allForms && pageData.allForms.length > 0) {
                for (const form of pageData.allForms) {
                    await aiInteract({ ...pageData, form }, folder);
                }
            } else {
                // If no forms, maybe still do something (for navigation-only, etc)
                await aiInteract({ ...pageData, form: null }, folder);
            }

            // aiResult.summary, aiResult.resultHtml, aiResult.outcome, aiResult.error (if any)

            // Enqueue new same-domain links (from this page and from ai)
            let newLinks = pageData.links?.filter(l => {
                try {
                    const absUrl = new URL(l, baseDomain);
                    // Only crawl if:
                    // 1. Same origin as original domain
                    // 2. Not just a hash/anchor or current-page-with-different-hash
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
            for (const l of newLinks) pagesToVisit.push({ url: l, depth: depth + 1 });

        } catch (err) {
            console.warn("Error crawling", url, err.message);
        } finally {
            await page.close();
            await context.close();
            await browser.close();
        }
    }
}

(async () => {
    await recursiveCrawl(DOMAIN, MAX_DEPTH);
})();
