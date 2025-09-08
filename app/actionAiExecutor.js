import { generateLoginStatements } from '../ai/login.js';
import { generateActionCoderPrompt } from '../ai/actionPrompt.js';
import { generateActionStatements } from '../ai/actionCode.js';
import { judgeOutcome } from '../ai/judge.js';
import { codeWrap, safeEvalFunction } from '../runtime/sandbox.js';
import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import crypto from 'crypto';
import { openai } from '../ai/client.js';
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
// ---------------- Utils ----------------
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
    const words = base.split(/\\s+/);
    return words.slice(0, 40).join(' ');
  } catch { return 'Web page summary unavailable.'; }
}
function isLikelyLoginForm(action) {
  const fields = (action?.inputs || []).map(i => `${(i?.name||'').toLowerCase()} ${(i?.id||'').toLowerCase()} ${(i?.label||'').toLowerCase()}`).join(' ');
  const hasUser = /(user|email|login)/i.test(fields);
  const hasPass = /pass(word)?/i.test(fields);
  const actionText = `${action?.text||''} ${action?.role||''} ${action?.name||''}`.toLowerCase();
  return hasUser && hasPass || /login|sign\s*in/.test(actionText);
}

function buildRunId() { return `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }



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
  const existing = await Pages.findOne({ project_id: projectId, url });
  const htmlId = await uploadToGridFS({
    filename: `page_${sha1(Buffer.from(url + html)).slice(0,8)}.html`,
    buffer: Buffer.from(html, 'utf8'),
    contentType: 'text/html; charset=utf-8',
    metadata: { project_id: projectId, url, kind: 'page-html' },
  });
  const shotId = null;
  if (existing) {
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

// ----- Prompts -----
function buildPromptForPrompt({ pageDoc, action, project }) {
  const creds = project?.credentials || null;
  const pageLooksLogin = /login|sign\s*in|authenticate/i.test(String(pageDoc?.page_summary || '')) || isLikelyLoginForm(action);
  const credHint = pageLooksLogin && creds?.username && creds?.password
    ? `Use the provided credentials via variables: username=project.credentials.username, password=project.credentials.password.`
    : `If credentials are required and not provided, use reasonable test values from action.inputs.example_value or generic safe defaults.`;

  return [
    { role: 'system', content: 'You are a senior prompt engineer. Craft a crisp, effective prompt for a coding LLM.' },
    { role: 'user', content: `Context for the task:
- Page summary: ${pageDoc?.page_summary || 'N/A'}
- URL: ${pageDoc?.url || 'N/A'}
- Action JSON (verbatim):
${JSON.stringify(action, null, 2)}
- Project credentials presence: ${!!(project?.credentials)}

Goal: Write the SINGLE best instruction prompt that, when sent to a coding LLM, returns Playwright JS statements that can run INSIDE an async function with variables { page, action, project, helpers }.

Requirements for the code the LLM will output (do NOT include code yourself):
1) Navigate only if needed; assume the caller already loaded the page.
2) Fill fields using the most specific selectors in action (prefer selectors.best or selectors.css). Avoid hardcoded IDs/names not present in action.
3) ${credHint}
4) Click the submit button for the action (if any).
5) Wait appropriately (navigation or networkidle).
6) Avoid imports; use only the provided "page".
7) Use await as needed.
8) No comments or explanations; just the statements.
9) Keep it idempotent and robust.

Return ONLY the prompt text for the coding model — no commentary.` }
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
    { role: 'system', content: `You are a strict QA judge. Reply as compact JSON with keys: {
  classification: one of ["expected_result","failed_on_load","unexpected_result","infinite_error","continuation"],
  summary: short plain sentence (<=30 words),
  expected: boolean,
  continuation: boolean,
  reasoning: brief string (<=60 words)
}.` },
    { role: 'user', content:
`Initial URL: ${preUrl}
Result URL: ${postUrl}
Original page summary: ${originalPageSummary}
Action (JSON):
${JSON.stringify(action, null, 2)}

Result HTML (truncated to 5k chars, collapsed whitespace):
${trimmedHtml}

Heuristics:
- If this appears to be a successful login/submit leading to a new page or showing success text, label expected_result.
- If the same page content persists without change but suggests a next step (another form), set classification=continuation and continuation=true.
- If the page shows explicit errors or unexpected content, classify unexpected_result.
- If it looks like we never loaded properly, classify failed_on_load.
Return ONLY the JSON.` }
  ];
}

// NEW: dedicated login prompt that forbids hardcoded ids/names
function buildPromptForLogin({ loginUrl }) {
  return [
    { role: 'system', content: `You generate Playwright JavaScript for robust login. Return ONLY executable statements, no wrapping function, no imports, no comments.
Constraints:
- Do NOT hardcode element IDs or names. Discover elements generically.
- Find a visible form that contains at least one password-type input.
- Within the same form, locate the username/email input heuristically (text/email/tel inputs, or inputs with placeholder/aria-label/label containing "email", "user", or "login").
- Fill username with project.credentials.username and password with project.credentials.password.
- Click the submit button inside that form (type=submit or text matches /log\s*in|sign\s*in|continue|next|submit/i).
- Wait for either navigation, URL change, or networkidle after submit.` },
    { role: 'user', content: `The login page URL is: ${loginUrl}
Variables available: { page, project, helpers }` }
  ];
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

  const HEADLESS = String(headless) !== 'false';

  // capture cookies/localStorage for token diff
  function tokenSnapshot(page) {
    return page.evaluate(() => ({
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage || {})),
    }));
  }
  function sniffTokens({ cookiesBefore = [], cookiesAfter = [], storageBefore = {}, storageAfter = {} }) {
    const beforeNames = new Set((cookiesBefore || []).map(c => c.name));
    const afterNames = new Set((cookiesAfter || []).map(c => c.name));
    const newCookieNames = [...afterNames].filter(n => !beforeNames.has(n));
    const tokenLike = (n) => /token|auth|access|jwt|session|sid|bearer/i.test(n || '');
    const newTokenCookies = (cookiesAfter || []).filter(c => !beforeNames.has(c.name) || tokenLike(c.name));
    const lsBefore = storageBefore?.localStorage || {};
    const lsAfter = storageAfter?.localStorage || {};
    const newLsKeys = Object.keys(lsAfter).filter(k => !(k in lsBefore));
    const tokenLs = Object.entries(lsAfter).filter(([k,v]) => tokenLike(k) || tokenLike(String(v)));
    const success = newTokenCookies.length > 0 || tokenLs.length > 0 || newCookieNames.length > 0 || newLsKeys.length > 0;
    return { success, newCookieNames, newTokenCookies, newLsKeys, tokenLs };
  }

  await (async function withBrowserRun() {
    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ storageState: project?.storage_state || undefined, recordVideo: { dir: '/tmp/aionqa_videos' } });
    const page = await context.newPage();

    // Helpers passed into AI code + login step
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

    // Heuristic staged login with 60s decision loop
    async function waitForMeaningfulChange(prevUrl, prevHash, timeoutMs = 60_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const nowUrl = normalizeUrl(page.url());
        let changed = nowUrl !== prevUrl;
        if (!changed) {
          try {
            const nowHtml = await page.content();
            const nowHash = htmlHash(nowHtml);
            changed = changed || nowHash !== prevHash;
            if (changed) return true;
          } catch {}
        } else {
          return true;
        }
        await page.waitForTimeout(1000).catch(()=>{});
      }
      return false;
    }

    async function queryOne(locatorProducer) {
      try { const loc = locatorProducer(); if (await loc.first().isVisible({ timeout: 500 }).catch(()=>false)) return loc.first(); } catch {}
      return null;
    }

    async function fillEmailIfPresent(username) {
      const byRole = await queryOne(() => page.getByRole('textbox', { name: /email|user|login/i }));
      const byType = await queryOne(() => page.locator('input[type="email"]')) || await queryOne(() => page.locator('input[type="text"][name*="email" i]'));
      const target = byRole || byType;
      if (target) {
        try { await target.fill(String(username), { timeout: 5_000 }); return true; } catch {}
      }
      return false;
    }

    async function clickPrimaryContinueOrSubmit() {
      const candidates = [
        () => page.getByRole('button', { name: /continue|next|sign\s*in|submit|verify/i }),
        () => page.locator('button[type="submit"]'),
        () => page.locator('input[type="submit"]'),
        () => page.locator('button')
      ];
      for (const make of candidates) {
        const loc = await queryOne(make);
        if (loc) { try { await loc.click({ timeout: 5_000 }); return true; } catch {} }
      }
      return false;
    }

    async function fillPasswordIfPresent(password) {
      const passLoc = await queryOne(() => page.getByRole('textbox', { name: /pass(word)?/i }))
        || await queryOne(() => page.locator('input[type="password"]'));
      if (passLoc) { try { await passLoc.fill(String(password), { timeout: 5_000 }); return true; } catch {} }
      return false;
    }

    async function heuristicLoginWithDecisionLoop(projectCreds) {
      if (!projectCreds?.username) return false;
      const beforeUrl = normalizeUrl(page.url());
      const beforeHash = htmlHash(await page.content());

      let acted = false;

      // 1) If an email-only stage is present, fill and try to continue
      const filledEmail = await fillEmailIfPresent(projectCreds.username);
      if (filledEmail) {
        acted = true;
        await clickPrimaryContinueOrSubmit();
      }

      // 2) If password appears, fill and submit
      const passFilled = await fillPasswordIfPresent(projectCreds.password);
      if (passFilled) {
        acted = true;
        await clickPrimaryContinueOrSubmit();
      }

      // 3) If the page shows explicit SSO redirect, click the redirect button
      const ssoBtn = await queryOne(() => page.getByRole('button', { name: /redirect/i }));
      if (ssoBtn) { acted = true; try { await ssoBtn.click({ timeout: 5_000 }); } catch {} }

      // 4) Wait for any meaningful change up to 60s; if none, try fallback interactions
      const changed = await waitForMeaningfulChange(beforeUrl, beforeHash, 60_000);
      if (changed) return true;

      // Fallbacks if still stuck: press Enter in focused field and try again
      try { await page.keyboard.press('Enter'); } catch {}
      const changedAfterEnter = await waitForMeaningfulChange(beforeUrl, beforeHash, 10_000);
      return acted || changedAfterEnter;
    }

    try {
      // --- Login bootstrap (AI-driven + heuristic staged flow) ---
      if (project?.credentials?.username && project?.credentials?.password) {
        const loginUrl = project?.credentials?.login_url || pageDoc.url;
        console.log(`🔐 AI-driven login at: ${loginUrl}`);
        const cookiesBefore = await context.cookies();
        const storageBefore = await tokenSnapshot(page).catch(() => ({}));

        // Navigate to login URL
        await page.goto(loginUrl, { waitUntil: 'load', timeout: 60_000 }).catch(()=>{});

        // Ask coding model to generate generic login code (no hardcoded ids/names)
        const loginMsgs = buildPromptForLogin({ loginUrl });
        const loginPromptRef = await Prompts.insertOne({
          project_id: PROJECT_ID, created_at: new Date(), purpose: 'login-coder-prompt', model: 'gpt-5-mini', messages: loginMsgs
        }).then(x => x.insertedId);

        const loginChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: loginMsgs});
        const loginStatements = (loginChat.choices?.[0]?.message?.content || '').trim();

        // Save the raw login code for traceability
        await Projects.updateOne({ _id: PROJECT_ID }, {
          $set: { 'credentials.login_url': loginUrl },
          $push: { login_interactions: { created_at: new Date(), prompt_ref: loginPromptRef, ai_code: loginStatements } }
        });

        const wrappedLogin = codeWrap(loginStatements);
        let aiRan = false;
        try {
          const fnLogin = await safeEvalFunction(wrappedLogin, { console, page, action: null, project, helpers });
          await fnLogin({ page, action: null, project, helpers });
          aiRan = true;
          await helpers.waitStable();
        } catch (e) {
          console.error('❌ AI login code execution error:', e?.message || e);
        }

        // Heuristic staged handler for pages that first ask only for email (e.g., "Continue")
        try {
          const successHeuristic = await heuristicLoginWithDecisionLoop(project.credentials);
          if (!aiRan && !successHeuristic) {
            // If neither AI nor heuristic caused change, try heuristic again once more
            await heuristicLoginWithDecisionLoop(project.credentials);
          }
        } catch {}

        // Wait a bit for any async token writes
        await page.waitForTimeout(1500).catch(()=>{});

        // Capture tokens/cookies diffs
        const cookiesAfter = await context.cookies();
        const storageAfter = await tokenSnapshot(page).catch(() => ({}));
        const tokenInfo = sniffTokens({ cookiesBefore, cookiesAfter, storageBefore, storageAfter });

        // Persist cookies always; persist token info; set last_login status
        try {
          await Projects.updateOne(
            { _id: PROJECT_ID },
            {
              $set: {
                cookies: cookiesAfter,
                auth: {
                  last_login_at: new Date(),
                  acknowledged_success: !!tokenInfo.success,
                  login_url: loginUrl,
                  new_cookie_names: tokenInfo.newCookieNames,
                  new_localstorage_keys: tokenInfo.newLsKeys,
                  token_like_localstorage: tokenInfo.tokenLs,
                }
              }
            }
          );
          if (tokenInfo.success) {
            console.log('✅ Login succeeded (tokens/cookies detected).');
          } else {
            console.log('ℹ️ Login flow ran; no obvious new tokens detected.');
          }
        } catch (e) {
          console.warn('⚠️ Could not store tokens/cookies:', e?.message || e);
        }
      } else if (Array.isArray(project?.cookies) && project.cookies.length) {
        // Seed cookies if we already have them
        try { await context.addCookies(project.cookies); } catch {}
      }

      // --- Navigate to action starting page ---
      console.log(`🌐 Navigating to: ${pageDoc.url}`);
      const navRes = await page.goto(pageDoc.url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(e => { console.error(e); return null; });
      if (!navRes) console.warn('⚠️ Initial navigation may have failed; continuing…');

      // --- Action loop ---
      for (let step = 0; step < maxSteps; step++) {
        console.log(`\\n🚦 Step ${step+1}/${maxSteps}`);
        const beforeUrl = normalizeUrl(page.url());
        const beforeHtml = await page.content();
        const beforeHash = htmlHash(beforeHtml);

        // (1) Ask AI to write the best CODING prompt
        const promptMessages = buildPromptForPrompt({ pageDoc, action, project });
        const promptRefId = await Prompts.insertOne({
          project_id: PROJECT_ID, created_at: new Date(), purpose: 'action-generate-coder-prompt', model: 'gpt-5-mini', messages: promptMessages
        }).then(x => x.insertedId);
        const promptChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: promptMessages});
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
        const codePromptRefId = await Prompts.insertOne({
          project_id: PROJECT_ID, created_at: new Date(), purpose: 'action-generate-code', model: 'gpt-5-mini', messages: codeMessages
        }).then(x => x.insertedId);
        const codeChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: codeMessages});
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
        // If we stayed on the same URL but captured a screenshot, attach it to the existing page
        if (!resultPageId && screenshot_file_id) {
          try { await Pages.updateOne({ _id: PAGE_ID }, { $set: { screenshot_file_id, analyzed: true } }); } catch {}
        }

        // (8) Ask AI to judge
        const judgeMessages = buildPromptForJudge({ preUrl: beforeUrl, postUrl: afterUrl, html: afterHtml, originalPageSummary: pageDoc.page_summary, action });
        const judgePromptRefId = await Prompts.insertOne({
          project_id: PROJECT_ID, created_at: new Date(), purpose: 'action-judge-result', model: 'gpt-5-mini', messages: judgeMessages
        }).then(x => x.insertedId);
        let classification = 'unexpected_result';
        let summary = 'Outcome unclear.';
        let continuation = false;
        try {
          const judgeChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: judgeMessages});
          const jtxt = (judgeChat.choices?.[0]?.message?.content || '{}').trim();
          try {
            const j = JSON.parse(jtxt);
            classification = j.classification || classification;
            summary = j.summary || summary;
            continuation = !!j.continuation;
          } catch {
            summary = 'Judger returned non-JSON; treating as unexpected.';
          }
        } catch (e) {
          console.error('❌ Judge error:', e?.message || e);
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

        if (executionError) {
          console.log('⏭️  Stopping after execution error.');
          break;
        }

        if (continuation && !seenBefore && !sameAsBefore) {
          console.log('🔁 Judger suggests continuation; looping…');
          continue;
        }

        if (sameAsBefore || seenBefore) {
          console.log('🟰 Same outcome or seen state; stopping.');
          break;
        }

        if (step === maxSteps - 1) {
          console.log('⛳ Reached max steps; stopping.');
          break;
        }
      }

      console.log('✅ Done.');
      await context.close().catch(()=>{});
      await browser.close().catch(()=>{});
    } catch (e) {
      console.error(e);
      try { await context.close(); } catch {}
      try { await browser.close(); } catch {}
      process.exit(1);
    }
  })();

  await client.close();
})().catch(async (e) => {
  console.error(e);
  try { await client.close(); } catch {}
  process.exit(1);
});