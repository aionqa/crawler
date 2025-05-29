// crawler.js
import { PlaywrightCrawler, log } from 'crawlee';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DEBUG_LEVEL = process.env.DEBUG_LEVEL;
log.setLevel(DEBUG_LEVEL);

export async function crawlPageWithPlaywright(startUrl, headers = {}) {
    if (typeof startUrl !== 'string' || !startUrl.startsWith('http')) {
        throw new Error('Invalid URL passed to crawler');
    }

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

            const { protocol, hostname, pathname } = new URL(startUrl);
            const safePath = pathname.replace(/[^a-z0-9]/gi, '_').slice(0, 50) || 'root';
            const folder = path.join('outcome', protocol.replace(':', ''), hostname, safePath);
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
