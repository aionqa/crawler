#!/usr/bin/env node
// singlePageAnalyzer.js — analyze ONE page for a given project OID + URL.
// - CLI params only: --url, --project, [--force]; no TARGET_URL/PROJECT_NAME envs.
// - Upserts the project by _id, not name.
// - Skips if already analyzed for that project+url unless --force.
// - Saves artifacts (HTML/screenshot) to GridFS and actions to regular collections.

import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import OpenAI from 'openai';
import crypto from 'crypto';
import { z } from 'zod';

// ---------------- CLI ----------------
function args(argv) {
  const out = { url: null, projectRaw: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' || a === '-u') out.url = argv[++i];
    else if (a === '--project' || a === '-p') out.projectRaw = argv[++i];
    else if (a === '--force' || a === '-f') out.force = true;
  }
  return out;
}
const { url: TARGET_URL, projectRaw, force: FORCE } = args(process.argv.slice(2));
if (!TARGET_URL) {
  console.error('Usage: node singlePageAnalyzer.js --url <URL> --project <MongoObjectId> [--force]');
  process.exit(2);
}
if (!projectRaw || !ObjectId.isValid(projectRaw)) {
  console.error('Error: --project must be a valid Mongo ObjectId (24 hex chars).');
  process.exit(2);
}
const PROJECT_ID = new ObjectId(projectRaw);

// ---------------- Env (non-target) ----------------
const {
  OPENAI_API_KEY,
  MONGODB_URI = 'mongodb://127.0.0.1:27017',
  DB_NAME = 'spa',
  HEADLESS = 'true',
} = process.env;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

// ---------------- Mongo ----------------
const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Projects = db.collection('projects');
const Pages = db.collection('pages');
const Actions = db.collection('actions');
const Prompts = db.collection('prompts');
const CodeTests = db.collection('code_tests');
const bucket = new GridFSBucket(db, { bucketName: 'artifacts' });

// ---------------- OpenAI ----------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
const OptStr = z.string().trim().min(1).max(20000).nullish();
const NonEmptyStr = z.string().trim().min(1).max(20000);
const Sel = z.object({ best: OptStr, css: OptStr, xpath: OptStr }).strict();
const InteractiveElement = z.object({
  element_type: z.enum(['form','button','link','input','select','textarea','other']),
  id: OptStr, name: OptStr, text: OptStr, role: OptStr, action: OptStr, method: OptStr, href: OptStr, target: OptStr,
  selectors: Sel.nullish(),
  inputs: z.array(z.object({
    label: OptStr, name: OptStr, id: OptStr, type: OptStr, placeholder: OptStr, selectors: Sel.nullish(), example_value: OptStr,
  }).strict()).default([]),
  submit_button: z.object({ text: OptStr, selectors: Sel.nullish() }).nullish(),
  playwright_script: OptStr,
  result_checks: z.array(z.object({
    kind: z.enum(['url_contains','selector_visible','text_present','network_call']),
    value: NonEmptyStr,
  }).strict()).default([]),
  ai_confidence: z.number().min(0).max(1).nullish(),
}).strict();
const ModelResponse = z.object({
  page_summary: OptStr,
  interactive_elements: z.array(InteractiveElement),
}).strict();

function buildPrompt({ url, html, screenshotDataUrl }) {
  return [
    { role: 'system', content: 'You are a meticulous UI analyzer. Output STRICT JSON per schema. No prose.' },
    {
      role: 'user',
      content: [
        { type: 'text', text:
              `Analyze ONLY this page.
First, set "page_summary" to a concise plain-English summary of the page in 1–2 sentences (<= 40 words).
Then list all interactive elements (forms, pseudo-forms, links, buttons). Include robust selectors and a Playwright script for each element, plus result checks.
Return STRICT JSON per schema, no commentary.` },
        { type: 'text', text: `URL: ${url}` },
        { type: 'text', text: `HTML (truncated):\n${html.slice(0, 150000)}` },
        { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'low' } },
      ],
    },
  ];
}
async function toDataUrlPng(buf) {
  const b64 = Buffer.from(buf).toString('base64');
  return `data:image/png;base64,${b64}`;
}
function stripImagesFromMessages(o) {
  const c = JSON.parse(JSON.stringify(o));
  if (Array.isArray(c.messages)) {
    c.messages = c.messages.map(m => m.role === 'user'
        ? { ...m, content: (m.content || []).filter(p => p.type !== 'image_url') }
        : m);
  }
  return c;
}

// Minimal DOM helpers (unchanged from your version)
async function extractLinksAsActionsViaDOM(page) {
  return await page.evaluate(() => {
    function isVisible(el){ const s = getComputedStyle(el); return s && s.visibility!=='hidden' && s.display!=='none'; }
    function uniqueCss(el){ if (!el) return null; if (el.id) return `#${CSS.escape(el.id)}`; const parts=[]; let cur=el;
      while(cur && cur.nodeType===1 && parts.length<6){ let sel=cur.nodeName.toLowerCase();
        if(cur.id){ sel=`#${CSS.escape(cur.id)}`; parts.unshift(sel); break; }
        const sibs=[...(cur.parentElement?.children||[])];
        const same=sibs.filter(s=>s.nodeName===cur.nodeName);
        if(same.length>1) sel+=`:nth-of-type(${same.indexOf(cur)+1})`;
        parts.unshift(sel); cur=cur.parentElement;
      } return parts.join(' > ');
    }
    function uniqueXPath(el){ if(!el||el.nodeType!==1) return null; if(el.id) return `//*[@id="${el.id}"]`;
      const segs=[]; let cur=el; while(cur&&cur.nodeType===1&&cur!==document.documentElement){ const tag=cur.tagName.toLowerCase();
        let i=1,p=cur.previousElementSibling; while(p){ if(p.tagName.toLowerCase()===tag) i++; p=p.previousElementSibling; }
        segs.unshift(`${tag}[${i}]`); if(cur.id) return `//*[@id="${cur.id}"]/${segs.slice(1).join('/')}`; cur=cur.parentElement; }
      return `/${segs.join('/')}`;
    }
    const anchors=[...document.querySelectorAll('a[href]')].filter(isVisible).filter(a=>!/^javascript:/i.test(a.getAttribute('href')||''));
    const seen=new Set();
    return anchors.map(a=>{
      const css=uniqueCss(a), xpath=uniqueXPath(a);
      const text=(a.innerText||'').trim()||null;
      return { text, href: a.href||a.getAttribute('href'), selectors:{best:css,css,xpath} };
    }).filter(x=>{ const k=`${x.href}::${x.selectors.best}`; if(seen.has(k)) return false; seen.add(k); return true; });
  });
}
async function extractFormGroupsViaDOM(page) {
  return await page.evaluate(() => {
    // ---------- helpers ----------
    function isVisible(el){
      const s = getComputedStyle(el);
      return s && s.visibility !== 'hidden' && s.display !== 'none' && el.offsetParent !== null;
    }
    function isSubmitty(el){
      const t = (el.innerText || el.value || '').toLowerCase();
      return (
          el.matches('input[type="submit"], input[type="image"], button[type="submit"]') ||
          /^(submit|save|search|send|log\s*in|sign\s*in|continue|apply|go|next|enter)$/i.test(t) ||
          /\blogin\b|\bsign[\s-]?in\b|\bsubmit\b/i.test(t)
      );
    }
    function uniqueCss(el){
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.getAttribute && el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let sel = cur.nodeName.toLowerCase();
        if (cur.id) { sel = `#${CSS.escape(cur.id)}`; parts.unshift(sel); break; }
        const sibs = Array.from(cur.parentElement ? cur.parentElement.children : []);
        const same = sibs.filter(s => s.nodeName === cur.nodeName);
        if (same.length > 1) sel += `:nth-of-type(${same.indexOf(cur) + 1})`;
        parts.unshift(sel);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }
    function uniqueXPath(el){
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return `//*[@id="${el.id}"]`;
      const segs = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        const tag = cur.tagName.toLowerCase();
        let i = 1, p = cur.previousElementSibling;
        while (p) { if (p.tagName.toLowerCase() === tag) i++; p = p.previousElementSibling; }
        segs.unshift(`${tag}[${i}]`);
        if (cur.id) return `//*[@id="${cur.id}"]/${segs.slice(1).join('/')}`;
        cur = cur.parentElement;
      }
      return `/${segs.join('/')}`;
    }
    function serializeInput(el){
      const css = uniqueCss(el), xpath = uniqueXPath(el);
      return {
        label: (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : null),
        name: el.getAttribute('name'),
        id: el.id || null,
        type: (el.getAttribute('type') || el.nodeName.toLowerCase()),
        placeholder: el.getAttribute('placeholder'),
        selectors: { best: css, css, xpath },
        example_value: null,
      };
    }
    function serializeButton(el){
      const css = uniqueCss(el), xpath = uniqueXPath(el);
      const text = (el.innerText || el.value || '').trim() || null;
      return { text, selectors: { best: css, css, xpath } };
    }
    function lca(nodes){
      const valid = nodes.filter(Boolean);
      if (!valid.length) return null;
      const paths = valid.map(n => {
        const arr = [];
        let cur = n;
        while (cur) { arr.unshift(cur); cur = cur.parentElement; }
        return arr;
      });
      const min = Math.min(...paths.map(p => p.length));
      let last = null;
      for (let i = 0; i < min; i++) {
        const cand = paths[0][i];
        if (paths.every(p => p[i] === cand)) last = cand; else break;
      }
      return last;
    }
    function containsSelector(outerCss, innerCss) {
      try {
        const outer = document.querySelector(outerCss);
        const inner = document.querySelector(innerCss);
        return !!(outer && inner && outer.contains(inner));
      } catch { return false; }
    }
    function domDepth(cssSel) {
      try {
        let d = 0, cur = document.querySelector(cssSel);
        while (cur && cur !== document.documentElement) { d++; cur = cur.parentElement; }
        return d;
      } catch { return 0; }
    }
    function selKey(sel) { return sel?.best || sel?.css || null; }
    function inputKey(i) {
      return i?.selectors?.best || i?.selectors?.css || i?.id || i?.name || null;
    }
    function jaccard(aArr, bArr) {
      const A = new Set(aArr.filter(Boolean)), B = new Set(bArr.filter(Boolean));
      const inter = [...A].filter(x => B.has(x)).length;
      const uni = new Set([...A, ...B]).size || 1;
      return inter / uni;
    }
    function looksLikeAuth(el){
      if (!el) return 0;
      const id = (el.id || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const txt = `${id} ${cls}`;
      let score = 0;
      if (el.tagName && el.tagName.toLowerCase() === 'form') score += 2;
      if (/\blogin\b|\bsign[\s-]?in\b|\bauth\b/.test(txt)) score += 2;
      if (/\bmax[-_ ]?width\b|\bcontainer\b|\boverflow\b|\bmain\b/.test(txt)) score -= 1;
      return score;
    }

    // ---------- collect candidates ----------
    const groups = [];

    // Real <form>
    for (const f of Array.from(document.querySelectorAll('form'))) {
      if (!isVisible(f)) continue;
      const inputs = Array.from(f.querySelectorAll('input, select, textarea')).filter(isVisible);
      const buttons = Array.from(f.querySelectorAll('button, input[type="submit"], input[type="image"], [role="button"]')).filter(isVisible);
      const submit = buttons.find(isSubmitty) || null;
      if (!inputs.length || !submit) continue;

      const container = f;
      groups.push({
        kind: 'html-form',
        container_selector: uniqueCss(container),
        inputs: inputs.map(serializeInput),
        submit_button: serializeButton(submit),
        _submitKey: selKey(serializeButton(submit).selectors),
        _inputsKey: inputs.map(serializeInput).map(inputKey),
        _depth: domDepth(uniqueCss(container)),
        _pref: looksLikeAuth(container),
      });
    }

    // Pseudo-forms (inputs + a submit-like control within a generic container)
    const scanRoots = Array.from(document.querySelectorAll('div, section, main, article, aside'));
    for (const root of scanRoots) {
      if (!isVisible(root)) continue;

      const visInputs = Array.from(root.querySelectorAll('input, select, textarea')).filter(isVisible);
      if (!visInputs.length) continue;

      const visButtons = Array.from(root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="image"]')).filter(isVisible);
      if (!visButtons.length) continue;

      const submit = visButtons.find(isSubmitty);
      if (!submit) continue;

      // Tighten container to LCA of inputs + submit
      const container = lca([...visInputs, submit]) || root;

      const serInputs = visInputs.map(serializeInput);
      const serSubmit = serializeButton(submit);
      const css = uniqueCss(container);

      groups.push({
        kind: 'pseudo-form',
        container_selector: css,
        inputs: serInputs,
        submit_button: serSubmit,
        _submitKey: selKey(serSubmit.selectors),
        _inputsKey: serInputs.map(inputKey),
        _depth: domDepth(css),
        _pref: looksLikeAuth(container),
      });
    }

    // ---------- de-duplicate ----------
    // Strategy:
    // 1) Sort by preference (auth-ish / real <form>) then by depth (deepest first).
    // 2) For groups that share the same submit and highly similar inputs, drop ancestors/wrappers.
    groups.sort((a, b) => {
      if (b._pref !== a._pref) return b._pref - a._pref;
      if (b._depth !== a._depth) return b._depth - a._depth;
      return (a.container_selector || '').length - (b.container_selector || '').length;
    });

    const kept = [];
    for (const g of groups) {
      const gSubmit = g._submitKey;
      const gInputs = g._inputsKey;
      const gSel = g.container_selector;

      const isDup = kept.some(k => {
        if (k._submitKey !== gSubmit) return false;
        const sim = jaccard(k._inputsKey, gInputs);
        if (sim < 0.8) return false;
        // If either container contains the other, treat as dup; we kept deeper first.
        return containsSelector(k.container_selector, gSel) || containsSelector(gSel, k.container_selector);
      });

      if (!isDup) kept.push(g);
    }

    // Strip meta keys
    return kept.map(({ _submitKey, _inputsKey, _depth, _pref, ...rest }) => rest);
  });
}
function dedupeFormGroupsNode(groups = []) {
  const by = (g) => ({
    submit: g?.submit_button?.selectors?.best || g?.submit_button?.selectors?.css || '',
    inputs: new Set((g.inputs || []).map(i =>
        i?.selectors?.best || i?.selectors?.css || i?.id || i?.name || ''
    )),
  });

  function jaccard(A, B) {
    const inter = [...A].filter(x => B.has(x)).length;
    const uni = new Set([...A, ...B]).size || 1;
    return inter / uni;
  }

  const withDepth = groups.map(g => ({
    g,
    depth: (g.selectors?.best || g.selectors?.css || '').split('>').length,
    submit: by(g).submit,
    inputsSet: by(g).inputs,
  }));

  withDepth.sort((a, b) => b.depth - a.depth); // deeper first

  const keep = [];
  for (const cand of withDepth) {
    const dup = keep.some(k =>
        k.submit === cand.submit &&
        jaccard(k.inputsSet, cand.inputsSet) >= 0.8
    );
    if (!dup) keep.push(cand);
  }
  return keep.map(x => x.g);
}
// ---------------- Main ----------------
(async () => {
  console.log('🧵 Connecting to MongoDB…');
  await client.connect();
  console.log('✅ MongoDB connected');

  // Ensure project exists by _id (never null)
  const up = await Projects.updateOne(
      { _id: PROJECT_ID },
      { $setOnInsert: { _id: PROJECT_ID, name: `project_${PROJECT_ID.toHexString()}`, created_at: new Date() } },
      { upsert: true }
  );
  console.log(`📌 Using project _id: ${PROJECT_ID}`);

  // Skip if this (project_id, url) already analyzed
  const already = await Pages.findOne({ project_id: PROJECT_ID, url: TARGET_URL });
  if (already && !FORCE) {
    console.log('ℹ️ Page already analyzed for this project. Use --force to re-analyze.');
    await client.close();
    process.exit(0);
  }

  // Browser → fetch page
  console.log('🎭 Launching Playwright…');
  const browser = await chromium.launch({ headless: HEADLESS !== 'false' });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`🌐 Navigating to: ${TARGET_URL}`);
  const navRes = await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!navRes) throw new Error('Navigation failed');

  // Artifacts
  const html = await page.content();
  const htmlId = await uploadToGridFS({
    filename: `page_${sha1(Buffer.from(html))}.html`,
    buffer: Buffer.from(html, 'utf8'),
    contentType: 'text/html; charset=utf-8',
    metadata: { project_id: PROJECT_ID, url: TARGET_URL, kind: 'page-html' },
  });
  const shotBuf = await page.screenshot({ fullPage: true, type: 'png' });
  const shotId = await uploadToGridFS({
    filename: `screenshot_${Date.now()}.png`,
    buffer: shotBuf,
    contentType: 'image/png',
    metadata: { project_id: PROJECT_ID, url: TARGET_URL, kind: 'page-screenshot' },
  });

  // DOM grouping + links
  const formGroupsRaw = await extractFormGroupsViaDOM(page);
  const formGroups = dedupeFormGroupsNode(formGroupsRaw);
  const linkActions = await extractLinksAsActionsViaDOM(page);

  // LLM extraction
  const messages = buildPrompt({ url: TARGET_URL, html, screenshotDataUrl: await toDataUrlPng(shotBuf) });
  const promptForDb = stripImagesFromMessages({ model: 'gpt-5-mini', messages });
  const promptId = (await Prompts.insertOne({
    project_id: PROJECT_ID,
    created_at: new Date(),
    prompt: promptForDb,
    purpose: 'single-page-extract',
  })).insertedId;

  const chat = await openai.chat.completions.create({
    model: 'gpt-5-mini',
    messages,
    temperature: 1,
    response_format: { type: 'json_object' },
  });
  const content = chat.choices?.[0]?.message?.content || '{}';
  let data;
  try { data = ModelResponse.parse(JSON.parse(content)); }
  catch { data = { page_summary: null, interactive_elements: [] }; }

  // Page doc
  const pageDoc = {
    project_id: PROJECT_ID,
    url: TARGET_URL,
    created_at: new Date(),
    html_file_id: htmlId,
    screenshot_file_id: shotId,
    page_summary: data.page_summary ?? null,
    form_groups: formGroups,
    prompt_ref: promptId,
    reanalyzed: !!already,
  };
  const insertedPage = await Pages.insertOne(pageDoc);
  const pageId = insertedPage.insertedId;

  // Actions + CodeTests
  const actionDocs = [];
  const codeTestDocs = [];

  data.interactive_elements.forEach((el, idx) => {
    actionDocs.push({
      project_id: PROJECT_ID,
      page_id: pageId,
      kind: el.element_type,
      id_attr: el.id ?? null,
      name: el.name ?? null,
      text: el.text ?? null,
      role: el.role ?? null,
      action: el.action ?? null,
      method: el.method ?? null,
      href: el.href ?? null,
      target: el.target ?? null,
      selectors: el.selectors ?? null,
      inputs: Array.isArray(el.inputs) ? el.inputs : [],
      submit_button: el.submit_button ?? null,
      ai_confidence: el.ai_confidence ?? null,
      ordinal: idx,
      created_at: new Date(),
      prompt_ref: promptId,
      source: 'model',
    });
    if (el.playwright_script) {
      codeTestDocs.push({
        project_id: PROJECT_ID,
        page_id: pageId,
        action_id: null, // filled after insertMany
        model: 'gpt-5-mini',
        script: el.playwright_script,
        result_checks: el.result_checks ?? [],
        created_at: new Date(),
        prompt_ref: promptId,
      });
    }
  });

  // Add link actions (DOM)
  linkActions.forEach((lnk, i) => {
    actionDocs.push({
      project_id: PROJECT_ID,
      page_id: pageId,
      kind: 'link',
      id_attr: null,
      name: null,
      text: lnk.text,
      role: null,
      action: null,
      method: null,
      href: lnk.href,
      target: null,
      selectors: lnk.selectors,
      inputs: [],
      submit_button: null,
      ai_confidence: null,
      ordinal: 20000 + i,
      created_at: new Date(),
      prompt_ref: promptId,
      source: 'dom-link',
    });
  });

  // Add grouped form actions (DOM)
  formGroups.forEach((fg, idx) => {
    actionDocs.push({
      project_id: PROJECT_ID,
      page_id: pageId,
      kind: 'form',
      id_attr: null,
      name: null,
      text: null,
      role: null,
      action: null,
      method: null,
      href: null,
      target: null,
      selectors: { best: fg.container_selector, css: fg.container_selector, xpath: null },
      inputs: fg.inputs || [],
      submit_button: fg.submit_button || null,
      ai_confidence: null,
      ordinal: 10000 + idx,
      created_at: new Date(),
      prompt_ref: promptId,
      source: 'dom-grouped',
    });
  });

  // Persist actions & backfill code tests
  let insertedActionIds = [];
  if (actionDocs.length) {
    actionDocs.sort((a, b) => {
      const ra = a.source === 'model' ? 0 : 1;
      const rb = b.source === 'model' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (a.ordinal ?? 0) - (b.ordinal ?? 0);
    });
    actionDocs.forEach((a, i) => { a.ordinal = i; });
    insertedActionIds = (await Actions.insertMany(actionDocs)).insertedIds;
  }
  if (codeTestDocs.length && insertedActionIds) {
    const modelIdsInOrder = actionDocs
        .map((doc, idx) => ({ idx, doc }))
        .filter(x => x.doc.source === 'model')
        .map(x => insertedActionIds[x.idx]);
    codeTestDocs.forEach((ct, i) => { ct.action_id = modelIdsInOrder[i]; });
    await CodeTests.insertMany(codeTestDocs.filter(ct => ct.action_id));
  }

  console.log('✅ Done.');
  await context.close();
  await browser.close();
  await client.close();
})().catch(async (e) => {
  console.error(e);
  try { await client.close(); } catch {}
  process.exit(1);
});
