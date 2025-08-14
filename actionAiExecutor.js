#!/usr/bin/env node
// actionAiExecutor.js — drive ONE action end‑to‑end using AI‑generated Playwright code
// Usage:
//   node actionAiExecutor.js --project_id <ObjectId> --page_id <ObjectId> --action_id <ObjectId> [--headless=true|false]
//
// What this does (per run):
// 1) Loads project, page, and action from MongoDB.
// 2) Asks the AI to WRITE the best prompt for a coding model to produce Playwright code.
// 3) Saves that prompt into Actions.ai_interactions[] (upsert-safe) as a new element.
// 4) Sends that AI-written prompt to the coding model to get JS code ("ai_code").
// 5) Executes the code safely inside a wrapper with Playwright Page and helper utils.
// 6) Captures HTML and screenshot, stores artifacts in GridFS, and records URL/result.
// 7) Asks AI to judge the outcome (expected/unexpected/etc) and summarize.
// 8) Writes back the summary, classification code, artifacts, and (if navigated) a Pages doc.
// 9) If the AI says it needs to continue (e.g., a follow‑up form), loops up to 20 steps or until content is identical once.
//
// Inspired by singlePageAnalyzer.js structure (Mongo, OpenAI, GridFS, Playwright, prompts, upserts).

import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import OpenAI from 'openai';
import crypto from 'crypto';
import vm from 'vm';

// ---------------- CLI ----------------
function argvToOpts(argv) {
    const out = { projectIdRaw: null, pageIdRaw: null, actionIdRaw: null, headless: 'true' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--project_id' || a === '--project') out.projectIdRaw = argv[++i];
        else if (a === '--page_id' || a === '--page') out.pageIdRaw = argv[++i];
        else if (a === '--action_id' || a === '--action') out.actionIdRaw = argv[++i];
        else if (a === '--headless') out.headless = argv[++i];
    }
    return out;
}
const { projectIdRaw, pageIdRaw, actionIdRaw, headless } = argvToOpts(process.argv.slice(2));
function mustObjectId(idRaw, flag) {
    if (!idRaw || !ObjectId.isValid(idRaw)) {
        console.error(`Error: ${flag} must be a valid Mongo ObjectId (24 hex chars).`);
        process.exit(2);
    }
    return new ObjectId(idRaw);
}
const PROJECT_ID = mustObjectId(projectIdRaw, '--project_id');
const PAGE_ID = mustObjectId(pageIdRaw, '--page_id');
const ACTION_ID = mustObjectId(actionIdRaw, '--action_id');

// ---------------- Env ----------------
const {
    OPENAI_API_KEY,
    MONGODB_URI = 'mongodb://127.0.0.1:27017',
    DB_NAME = 'spa',
} = process.env;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

// ---------------- Mongo ----------------
const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Projects = db.collection('projects');
const Pages = db.collection('pages');
const Actions = db.collection('actions');
const Prompts = db.collection('prompts');
const bucket = new GridFSBucket(db, { bucketName: 'artifacts' });

// ---------------- OpenAI ----------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- Utils ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
async function uploadToGridFS({ filename, buffer, contentType, metadata }) {
    return new Promise((resolve, reject) => {
        const up = bucket.openUploadStream(filename, { contentType, metadata });
        up.on('finish', () => resolve(up.id));
        up.on('error', reject);
        up.end(buffer);
    });
}
function deriveShortSummary(html) {
    try {
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g,' ').trim();
        const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        const base = [title, h1].filter(Boolean).join(' — ');
        if (!base) return 'Web page summary unavailable.';
        const words = base.split(/\s+/);
        return words.slice(0, 40).join(' ');
    } catch { return 'Web page summary unavailable.'; }
}
function trimHtmlForLLM(html, max = 150000) {
    if (!html) return '';
    if (html.length <= max) return html;
    const head = html.slice(0, Math.floor(max * 0.6));
    const tail = html.slice(-Math.floor(max * 0.4));
    return `${head}\n<!-- TRUNCATED (${html.length} bytes total) -->\n${tail}`;
}
function isLikelyLoginForm(action) {
    const fields = (action?.inputs || []).map(i => `${(i?.name||'').toLowerCase()} ${(i?.id||'').toLowerCase()} ${(i?.label||'').toLowerCase()}`).join(' ');
    const hasUser = /(user|email|login)/i.test(fields);
    const hasPass = /pass(word)?/i.test(fields);
    const actionText = `${action?.text||''} ${action?.role||''} ${action?.name||''}`.toLowerCase();
    return hasUser && hasPass || /login|sign\s*in/.test(actionText);
}

function buildRunId() { return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }

function codeWrap(aiStatements) {
    // We expect raw statements that can run in an async function body.
    return `async function __ai_exec__({ page, action, project, helpers }) {\n${aiStatements}\n}\n__ai_exec__;`;
}

async function safeEvalFunction(js, scope) {
    const script = new vm.Script(js, { timeout: 10_000, displayErrors: true });
    const ctx = vm.createContext({ ...scope });
    const exported = script.runInContext(ctx, { timeout: 10_000 });
    if (typeof exported !== 'function') throw new Error('AI code did not produce a function');
    return exported;
}

function normalizeUrl(u) { try { return new URL(u).toString(); } catch { return String(u || ''); } }

function htmlHash(html) { return sha1(Buffer.from(String(html || ''), 'utf8')); }

async function captureArtifacts(page, projectId, note) {
    const html = await page.content();
    const url = normalizeUrl(page.url());
    const shotBuf = await page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
    const htmlId = await uploadToGridFS({
        filename: `result_${sha1(Buffer.from(url + html)).slice(0,8)}.html`,
        buffer: Buffer.from(html, 'utf8'),
        contentType: 'text/html; charset=utf-8',
        metadata: { project_id: projectId, url, kind: 'result-html', note }
    });
    let shotId = null;
    if (shotBuf) {
        shotId = await uploadToGridFS({
            filename: `result_${Date.now()}.png`,
            buffer: shotBuf,
            contentType: 'image/png',
            metadata: { project_id: projectId, url, kind: 'result-screenshot', note }
        });
    }
    return { html, url, html_file_id: htmlId, screenshot_file_id: shotId };
}

async function upsertPageFromState({ url, html, projectId, previousPageId, fromActionId }) {
    // Create a new Pages doc for the resulting state (if URL differs from previous), or reuse if same (reanalyzed flag true)
    const existing = await Pages.findOne({ project_id: projectId, url });
    const htmlId = await uploadToGridFS({
        filename: `page_${sha1(Buffer.from(url + html)).slice(0,8)}.html`,
        buffer: Buffer.from(html, 'utf8'),
        contentType: 'text/html; charset=utf-8',
        metadata: { project_id: projectId, url, kind: 'page-html' },
    });
    const shotId = null; // optional: we already captured screenshot separately
    if (existing) {
        // Touch reanalyzed or append artifacts
        await Pages.updateOne({ _id: existing._id }, {
            $set: { page_summary: existing.page_summary || deriveShortSummary(html), reanalyzed: true },
            $setOnInsert: { created_at: new Date() },
        }, { upsert: false });
        return { page_id: existing._id, html_file_id: htmlId, screenshot_file_id: shotId };
    }
    const pageDoc = {
        project_id: projectId,
        url,
        created_at: new Date(),
        html_file_id: htmlId,
        screenshot_file_id: shotId,
        page_summary: deriveShortSummary(html),
        prompt_ref: null,
        reanalyzed: false,
        from_action_id: fromActionId || null,
        prev_page_id: previousPageId || null,
    };
    const ins = await Pages.insertOne(pageDoc);
    return { page_id: ins.insertedId, html_file_id: htmlId, screenshot_file_id: shotId };
}

function buildPromptForPrompt({ pageDoc, action, project }) {
    const creds = project?.credentials || null;
    const pageLooksLogin = /login|sign\s*in|authenticate/i.test(String(pageDoc?.page_summary || '')) || isLikelyLoginForm(action);
    const credHint = pageLooksLogin && creds?.username && creds?.password
        ? `Use the provided test credentials: username=\"${creds.username}\", password=\"${creds.password}\".`
        : `If credentials are required and not provided, use reasonable test values from action.inputs.example_value or generic safe defaults.`;

    return [
        { role: 'system', content: 'You are a senior prompt engineer. Craft a crisp, effective prompt for a coding LLM.' },
        { role: 'user', content: `Context for the task:\n- Page summary: ${pageDoc?.page_summary || 'N/A'}\n- URL: ${pageDoc?.url || 'N/A'}\n- Action JSON (verbatim):\n${JSON.stringify(action, null, 2)}\n- Project credentials presence: ${!!(project?.credentials)}\n\nGoal: Write the SINGLE best instruction prompt that, when sent to a coding LLM, returns Playwright JS statements that can run INSIDE an async function with variables { page, action, project, helpers }.\n\nRequirements for the code the LLM will output (do NOT include code yourself):\n1) Navigate only if needed; assume the caller already loaded the page.\n2) Fill fields using the most specific selectors in action (prefer selectors.best or selectors.css).\n3) ${credHint}\n4) Click the submit button for the action (if any).\n5) Wait appropriately (navigation or networkidle).\n6) Avoid imports; use only the provided \"page\".\n7) Use await as needed.\n8) No comments or explanations; just the statements.\n9) Keep it idempotent and robust.\n\nReturn ONLY the prompt text for the coding model — no commentary.` }
    ];
}

function buildPromptForCode(promptText) {
    return [
        { role: 'system', content: 'You generate Playwright JavaScript. Return ONLY executable statements, no wrapping function, no imports, no comments.' },
        { role: 'user', content: promptText }
    ];
}

function buildPromptForJudge({ preUrl, postUrl, html, originalPageSummary, action }) {
    const trimmedHtml = String(html || '').replace(/\s+/g, ' ').slice(0, 5000);
    return [
        { role: 'system', content: `You are a strict QA judge. Reply as compact JSON with keys: {\n  classification: one of [\"expected_result\",\"failed_on_load\",\"unexpected_result\",\"infinite_error\",\"continuation\"],\n  summary: short plain sentence (<=30 words),\n  expected: boolean,\n  continuation: boolean,\n  reasoning: brief string (<=60 words)\n}.` },
        { role: 'user', content:
                `Initial URL: ${preUrl}\nResult URL: ${postUrl}\nOriginal page summary: ${originalPageSummary}\nAction (JSON):\n${JSON.stringify(action, null, 2)}\n\nResult HTML (truncated to 5k chars, collapsed whitespace):\n${trimmedHtml}\n\nHeuristics:\n- If this appears to be a successful login/submit leading to a new page or showing success text, label expected_result.\n- If the same page content persists without change but suggests a next step (another form), set classification=continuation and continuation=true.\n- If the page shows explicit errors or unexpected content, classify unexpected_result.\n- If it looks like we never loaded properly, classify failed_on_load.\nReturn ONLY the JSON.` }
    ];
}

async function createPromptRecord(messages, purpose) {
    const record = { model: 'gpt-5-mini', messages, created_at: new Date(), purpose };
    const insert = await Prompts.insertOne(record);
    return insert.insertedId;
}

async function withBrowser(headlessFlag, fn) {
    const browser = await chromium.launch({ headless: String(headlessFlag) !== 'false' });
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        return await fn({ browser, context, page });
    } finally {
        await context.close().catch(()=>{});
        await browser.close().catch(()=>{});
    }
}

// ---------------- Main ----------------
(async () => {
    console.log('🧵 Connecting to MongoDB…');
    await client.connect();
    console.log('✅ MongoDB connected');

    const project = await Projects.findOne({ _id: PROJECT_ID });
    if (!project) throw new Error('Project not found');
    const pageDoc = await Pages.findOne({ _id: PAGE_ID, project_id: PROJECT_ID });
    if (!pageDoc) throw new Error('Page not found for this project');
    const action = await Actions.findOne({ _id: ACTION_ID, project_id: PROJECT_ID });
    if (!action) throw new Error('Action not found for this project');

    const run_id = buildRunId();
    const maxSteps = 20;
    const seen = new Set();

    await withBrowser(headless, async ({ page }) => {
        // Seed cookies if any
        if (Array.isArray(project.cookies) && project.cookies.length) {
            try { await page.context().addCookies(project.cookies); } catch {}
        }

        // Navigate to starting page
        console.log(`🌐 Navigating to: ${pageDoc.url}`);
        const navRes = await page.goto(pageDoc.url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(e => { console.error(e); return null; });
        if (!navRes) console.warn('⚠️ Initial navigation may have failed; continuing…');

        // Helpers passed into AI code
        const helpers = {
            async preferSelector(selObj, fallback) {
                if (!selObj) return fallback || null;
                return selObj.best || selObj.css || selObj.xpath || fallback || null;
            },
            async typeIfVisible(selector, value) {
                if (!selector) return;
                try { await page.fill(selector, value, { timeout: 10_000 }); } catch {}
            },
            async clickIfVisible(selector) {
                if (!selector) return;
                try { await page.click(selector, { timeout: 10_000 }); } catch {}
            },
            async waitStable() {
                try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch {}
            },
        };

        for (let step = 0; step < maxSteps; step++) {
            console.log(`\n🚦 Step ${step+1}/${maxSteps}`);
            const beforeUrl = normalizeUrl(page.url());
            const beforeHtml = await page.content();
            const beforeHash = htmlHash(beforeHtml);

            // (1) Ask AI to write the best CODING prompt
            const promptMessages = buildPromptForPrompt({ pageDoc, action, project });
            const promptRefId = await createPromptRecord(promptMessages, 'action-generate-coder-prompt');
            const promptChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: promptMessages, temperature: 1 });
            const coderPrompt = (promptChat.choices?.[0]?.message?.content || '').trim();

            // (2) Insert ai_interaction element with the prompt
            const interactionBase = {
                run_id, step, created_at: new Date(),
                prompt_ref: promptRefId, prompt_text: coderPrompt,
                ai_code: null, result: null, result_html_file_id: null, result_screenshot_file_id: null,
                result_url: null, result_page_id: null, summary: null, classification: null,
            };
            await Actions.updateOne({ _id: ACTION_ID }, { $push: { ai_interactions: interactionBase } });

            // (3) Ask coding model for the Playwright statements
            const codeMessages = buildPromptForCode(coderPrompt);
            const codePromptRefId = await createPromptRecord(codeMessages, 'action-generate-code');
            const codeChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: codeMessages, temperature: 1 });
            const aiStatements = (codeChat.choices?.[0]?.message?.content || '').trim();

            // (4) Save ai_code into the current interaction
            await Actions.updateOne(
                { _id: ACTION_ID },
                { $set: { 'ai_interactions.$[t].ai_code': aiStatements, 'ai_interactions.$[t].code_prompt_ref': codePromptRefId } },
                { arrayFilters: [{ 't.run_id': run_id, 't.step': step }] }
            );

            // (5) Execute the code inside a sandboxed wrapper
            const wrapped = codeWrap(aiStatements);
            let executionError = null;
            try {
                const fn = await safeEvalFunction(wrapped, { console, page, action, project, helpers });
                await fn({ page, action, project, helpers });
                await helpers.waitStable();
            } catch (err) {
                executionError = err;
                console.error('❌ AI code execution error:', err?.message || err);
            }

            // (6) Capture artifacts AFTER execution
            const { html: afterHtml, url: afterUrl, html_file_id, screenshot_file_id } = await captureArtifacts(page, PROJECT_ID, `action:${ACTION_ID} step:${step}`);
            const afterHash = htmlHash(afterHtml);

            // Stop if absolute same outcome once
            const key = `${normalizeUrl(afterUrl)}::${afterHash}`;
            const sameAsBefore = beforeHash === afterHash && beforeUrl === afterUrl;
            const seenBefore = seen.has(key);
            seen.add(key);

            // (7) If navigated to a different URL, upsert a Page doc for the result
            let resultPageId = null;
            if (afterUrl && normalizeUrl(afterUrl) !== normalizeUrl(pageDoc.url)) {
                const up = await upsertPageFromState({ url: afterUrl, html: afterHtml, projectId: PROJECT_ID, previousPageId: PAGE_ID, fromActionId: ACTION_ID });
                resultPageId = up.page_id;
            }

            // (8) Ask AI to judge
            const judgeMessages = buildPromptForJudge({ preUrl: beforeUrl, postUrl: afterUrl, html: afterHtml, originalPageSummary: pageDoc.page_summary, action });
            const judgePromptRefId = await createPromptRecord(judgeMessages, 'action-judge-result');
            let classification = 'unexpected_result';
            let summary = 'Outcome unclear.';
            let continuation = false;
            try {
                const judgeChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: judgeMessages, temperature: 1 });
                const txt = (judgeChat.choices?.[0]?.message?.content || '').trim();
                const parsed = JSON.parse(txt);
                if (parsed?.classification) classification = parsed.classification;
                if (parsed?.summary) summary = parsed.summary;
                if (typeof parsed?.continuation === 'boolean') continuation = parsed.continuation;
            } catch (e) {
                if (executionError) classification = 'infinite_error';
            }

            // Apply heuristic overrides
            if (executionError && classification !== 'failed_on_load') classification = 'infinite_error';
            if (sameAsBefore && continuation) {
                // Same content but AI asked to continue => break with continuation as terminal per spec
                continuation = false; // don’t continue further
            }
            if (seenBefore && classification === 'continuation') {
                // We reached an already-seen state while continuing — stop
                continuation = false;
            }

            // (9) Update the ai_interaction element with results
            await Actions.updateOne(
                { _id: ACTION_ID },
                { $set: {
                        'ai_interactions.$[t].result_url': afterUrl,
                        'ai_interactions.$[t].result_html_file_id': html_file_id,
                        'ai_interactions.$[t].result_screenshot_file_id': screenshot_file_id,
                        'ai_interactions.$[t].result_page_id': resultPageId,
                        'ai_interactions.$[t].summary': summary,
                        'ai_interactions.$[t].classification': classification,
                        'ai_interactions.$[t].judge_prompt_ref': judgePromptRefId,
                    }},
                { arrayFilters: [{ 't.run_id': run_id, 't.step': step }] }
            );

            console.log(`📄 Result URL: ${afterUrl}`);
            console.log(`🏷️ Classification: ${classification}`);
            console.log(`📝 Summary: ${summary}`);

            // Decide whether to continue
            if (!continuation) {
                console.log('⛳ Stopping (no continuation requested).');
                break;
            }
            if (step === maxSteps - 1) {
                console.log('⛳ Reached max steps; stopping.');
                break;
            }
        }
    });

    console.log('✅ Done.');
    await client.close();
})().catch(async (e) => {
    console.error(e);
    try { await client.close(); } catch {}
    process.exit(1);
});
