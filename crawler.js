import { PlaywrightCrawler, log } from 'crawlee';
import { ArgumentParser } from 'argparse';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const DEBUG = process.env.DEBUG === 'true';

// Suppress Crawlee logs to stdout
log.setLevel(log.LEVELS.ERROR);

const parser = new ArgumentParser();
parser.add_argument('--url', { required: true });
parser.add_argument('--headers', { help: 'JSON string of headers', default: '{}' });

const args = parser.parse_args();
const startUrl = args.url;
const headers = JSON.parse(args.headers);

const result = {
    url: startUrl,
    title: '',
    content: '',
    links: [],
    fields: [] // ✅ All form elements now go here
};

// Create screenshots directory
const screenshotDir = './screenshots';
fs.mkdirSync(screenshotDir, { recursive: true });

const crawler = new PlaywrightCrawler({
    async requestHandler({ page, request }) {
        if (headers && Object.keys(headers).length > 0) {
            await page.setExtraHTTPHeaders(headers);
        }

        await page.goto(request.url, { waitUntil: 'domcontentloaded' });

        // Screenshot
        const safeName = request.url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileHash = crypto.randomUUID().slice(0, 6);
        const filePath = path.join(screenshotDir, `${safeName}_${fileHash}.png`);
        await page.screenshot({ path: filePath, fullPage: true });

        if (DEBUG) console.error(`📸 Screenshot saved: ${filePath}`);

        result.title = await page.title();
        result.links = await page.$$eval('a', as => as.map(a => a.href));

        if (DEBUG) {
            console.error(`🧭 Title: ${result.title}`);
            console.error(`🔗 Links: ${result.links.length}`);
        }

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

        if (DEBUG) {
            console.error(`🧾 Found fields: ${result.fields.length}`);
            for (const field of result.fields) {
                console.error(`   - ${field.type} "${field.name}" @ ${field.domPath}`);
            }
        }
    }
});

await crawler.run([startUrl]);

// Save result to file
const debugDir = './debug';
fs.mkdirSync(debugDir, { recursive: true });
const debugFileSafeName = startUrl.replace(/[^a-z0-9]/gi, '_').toLowerCase();
const debugFilePath = path.join(debugDir, `${debugFileSafeName}.json`);
fs.writeFileSync(debugFilePath, JSON.stringify(result, null, 2));
if (DEBUG) console.error(`📄 JSON saved: ${debugFilePath}`);

// ✅ Only this prints to stdout
console.log(JSON.stringify(result));
