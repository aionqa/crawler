#!/usr/bin/env node
// singlePageAnalyzer.js — analyze ONE page for a given project OID + URL.
// - CLI params only: --url, --project, [--page_id], [--force]
// - Upserts the project by _id, not name.
// - Skips if already analyzed for that project+url unless --force.
// - Saves artifacts (HTML/screenshot) to GridFS and actions to regular collections.

import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import OpenAI from 'openai';
import crypto from 'crypto';
import { z } from 'zod';

// ------------- CLI -------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--page_id') o.page_id = argv[++i];
    else if (a === '--force') o.force = true;
  }
  return o;
}
const { url: TARGET_URL, project: projectRaw, page_id: pageIdRaw, force: FORCE } = parseArgs(process.argv.slice(2));
if (!TARGET_URL) {
  console.error('Usage: node singlePageAnalyzer.js --url <URL> --project <MongoObjectId> [--page_id <MongoObjectId>] [--force]');
  process.exit(2);
}
if (!projectRaw || !ObjectId.isValid(projectRaw)) {
  console.error('Error: --project must be a valid Mongo ObjectId (24 hex chars).');
  process.exit(2);
}
const PROJECT_ID = new ObjectId(projectRaw);
const PROVIDED_PAGE_ID = pageIdRaw && ObjectId.isValid(pageIdRaw) ? new ObjectId(pageIdRaw) : null;

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
const ShortStr = z.string().trim().min(1).max(280);
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
  page_summary: ShortStr,
  interactive_elements: z.array(InteractiveElement),
}).strict();

function identityUrl(u) { const x = new URL(u); x.hash = ''; return x.toString(); }

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

function buildPrompt({ url, html, screenshotDataUrl }) {
  return [
    { role: 'system', content: 'You are a meticulous UI analyzer. Output STRICT JSON per schema. No prose.' },
    {
      role: 'user',
      content: [
        { type: 'text', text:
              `Analyze ONLY this page.
First, set "page_summary" to a concise plain-English summary of the page in 1–2 sentences (<= 40 words).
Then output "interactive_elements" where EACH <form> is ONE action: element_type="form" with selectors pointing to the form container, an "inputs" array (label, name, id, type, placeholder, selectors, example_value for each field), and ONE "submit_button". DO NOT output separate actions for individual inputs of the same form.
For non-form actions, include buttons and links that trigger navigation or meaningful network calls.
Return STRICT JSON per schema, no commentary.` },
        { type: 'text', text: `URL: ${url}` },
        { type: 'text', text: `HTML (truncated):\n${html.slice(0, 150000)}` },
        { type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'low' } },
      ],
    },
  ];
}
async function toDataUrlPng(buf) { return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`; }
function stripImagesFromMessages(o) {
  const c = JSON.parse(JSON.stringify(o));
  if (Array.isArray(c.messages)) {
    c.messages = c.messages.map(m => m.role === 'user'
        ? { ...m, content: (m.content || []).filter(p => p.type !== 'image_url') }
        : m);
  }
  return c;
}

// ---- DOM helpers (unchanged) ----
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

    // Pseudo-forms
    const scanRoots = Array.from(document.querySelectorAll('div, section, main, article, aside'));
    for (const root of scanRoots) {
      if (!isVisible(root)) continue;

      const visInputs = Array.from(root.querySelectorAll('input, select, textarea')).filter(isVisible);
      if (!visInputs.length) continue;

      const visButtons = Array.from(root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="image"]')).filter(isVisible);
      if (!visButtons.length) continue;

      const submit = visButtons.find(isSubmitty);
      if (!submit) continue;

      const serializeInput = (el) => {
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
      };
      const serializeButton = (el) => {
        const css = uniqueCss(el), xpath = uniqueXPath(el);
        const text = (el.innerText || el.value || '').trim() || null;
        return { text, selectors: { best: css, css, xpath } };
      };

      const inputsSer = visInputs.map(serializeInput);
      const submitSer = serializeButton(submit);

      // LCA of inputs + submit
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
      const container = lca([...visInputs, submit]) || root;
      const css = uniqueCss(container);

      groups.push({
        kind: 'pseudo-form',
        container_selector: css,
        inputs: inputsSer,
        submit_button: submitSer,
        _submitKey: submitSer.selectors?.best || submitSer.selectors?.css || null,
        _inputsKey: inputsSer.map(i => i?.selectors?.best || i?.selectors?.css || i?.id || i?.name || null),
        _depth: (css || '').split('>').length,
        _pref: 0,
      });
    }

    // Dedup similar groups; prefer deeper containers
    groups.sort((a, b) => b._depth - a._depth);
    const kept = [];
    function containsSelector(outerCss, innerCss) {
      try {
        const outer = document.querySelector(outerCss);
        const inner = document.querySelector(innerCss);
        return !!(outer && inner && outer.contains(inner));
      } catch { return false; }
    }
    function jaccard(A, B) {
      const setA = new Set(A.filter(Boolean));
      const setB = new Set(B.filter(Boolean));
      const inter = [...setA].filter(x => setB.has(x)).length;
      const uni = new Set([...setA, ...setB]).size || 1;
      return inter / uni;
    }
    for (const g of groups) {
      const dup = kept.some(k => {
        if ((k._submitKey || '') !== (g._submitKey || '')) return false;
        if (jaccard(k._inputsKey || [], g._inputsKey || []) < 0.8) return false;
        return containsSelector(k.container_selector, g.container_selector) || containsSelector(g.container_selector, k.container_selector);
      });
      if (!dup) kept.push(g);
    }
    return kept.map(({ _submitKey, _inputsKey, _depth, _pref, ...rest }) => rest);
  });
}
function selToKey(sel) {
  try {
    if (!sel) return '';
    if (typeof sel === 'string') return sel.trim().toLowerCase();
    if (Array.isArray(sel)) return (sel[0] || '').trim().toLowerCase();
    const s = sel.best || sel.css || sel.xpath || '';
    return (s || '').trim().toLowerCase();
  } catch { return ''; }
}
function mergeInputs(baseInputs = [], addInputs = []) {
  const byKey = (i) => (i?.id || i?.name || selToKey(i?.selectors) || '').toLowerCase();
  const out = [...baseInputs];
  const idx = new Map(out.map((i, k) => [byKey(i), k]));
  for (const ai of addInputs) {
    const k = byKey(ai);
    if (!k) continue;
    if (idx.has(k)) {
      const bi = out[idx.get(k)];
      if ((!bi.example_value || !String(bi.example_value).trim()) && (ai.example_value && String(ai.example_value).trim())) {
        bi.example_value = ai.example_value;
      }
      if (!bi.selectors && ai.selectors) bi.selectors = ai.selectors;
      for (const f of ['label','type','placeholder','name','id']) {
        if (!bi[f] && ai[f]) bi[f] = ai[f];
      }
    } else {
      out.push(ai);
      idx.set(k, out.length - 1);
    }
  }
  return out;
}
function mergeSubmitButton(a = null, b = null) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  const aText = a.text || a.label || null;
  const bText = b.text || b.label || null;
  if (!aText && bText) out.text = bText;
  if (!out.selectors && b.selectors) out.selectors = b.selectors;
  return out;
}
function rankSource(s) { return s === 'dom-grouped' ? 0 : s === 'model' ? 1 : 2; }
function dedupeAndMergeActions(actionDocs) {
  const formsByKey = new Map();
  const removeIdx = new Set();
  for (let i = 0; i < actionDocs.length; i++) {
    const doc = actionDocs[i];
    if (doc.kind !== 'form') continue;
    const key = selToKey(doc.selectors);
    if (!key) continue;
    if (!formsByKey.has(key)) {
      formsByKey.set(key, i);
      continue;
    }
    const keepIdx = formsByKey.get(key);
    const keep = actionDocs[keepIdx];
    const cand = doc;
    let winner = keepIdx, loser = i;
    if (rankSource(cand.source) < rankSource(keep.source)) {
      winner = i; loser = keepIdx;
      formsByKey.set(key, winner);
    }
    const w = actionDocs[winner];
    const l = actionDocs[loser];
    if (!w.selectors && l.selectors) w.selectors = l.selectors;
    w.inputs = mergeInputs(Array.isArray(w.inputs) ? w.inputs : [], Array.isArray(l.inputs) ? l.inputs : []);
    w.submit_button = mergeSubmitButton(w.submit_button, l.submit_button);
    if (!w.method && l.method) w.method = l.method;
    if (!w.action && l.action) w.action = l.action;
    w.source = (w.source === l.source) ? w.source : 'dom+model-merged';
    removeIdx.add(loser);
  }
  const out = actionDocs.filter((_, idx) => !removeIdx.has(idx));
  return { actions: out, removedIndices: [...removeIdx] };
}

// ---------------- Main ----------------
(async () => {
  console.log('🧵 Connecting to MongoDB…');
  await client.connect();
  console.log('✅ MongoDB connected');

  // Ensure project exists by _id
  await Projects.updateOne(
      { _id: PROJECT_ID },
      { $setOnInsert: { _id: PROJECT_ID, name: `project_${PROJECT_ID.toHexString()}`, created_at: new Date() } },
      { upsert: true }
  );
  console.log(`📌 Using project _id: ${PROJECT_ID}`);

  const URL_ID = identityUrl(TARGET_URL);

  // Skip if already analyzed (by normalized URL) unless --force
  const already = await Pages.findOne({ project_id: PROJECT_ID, url: URL_ID });
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
  const formGroups = Array.isArray(formGroupsRaw) ? formGroupsRaw : [];
  const linkActions = await extractLinksAsActionsViaDOM(page); // (unused here but useful to log if you want)

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
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'SinglePageExtraction',
        strict: false,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['page_summary', 'interactive_elements'],
          properties: {
            page_summary: { type: 'string', description: '1–2 sentences, <= 40 words' },
            interactive_elements: { type: 'array', items: { type: 'object' } }
          }
        }
      }
    },
  });
  const content = chat.choices?.[0]?.message?.content || '{}';
  let dataRaw = {};
  try { dataRaw = JSON.parse(content || '{}'); } catch {}
  let data;
  const parsed = ModelResponse.safeParse(dataRaw);
  if (parsed.success) {
    data = parsed.data;
  } else {
    const aiElems = Array.isArray(dataRaw?.interactive_elements) ? dataRaw.interactive_elements : [];
    data = { page_summary: deriveShortSummary(html), interactive_elements: aiElems };
  }

  const page_summary_final =
      (typeof data.page_summary === 'string' && data.page_summary.trim().length)
          ? data.page_summary.trim()
          : deriveShortSummary(html);

  // -------- Upsert Page (idempotent + attach artifacts) --------
  let page_id;
  if (PROVIDED_PAGE_ID) {
    await Pages.updateOne(
        { _id: PROVIDED_PAGE_ID },
        {
          $setOnInsert: {
            project_id: PROJECT_ID,
            url: URL_ID,
            created_at: new Date(),
            // ⚠️ DO NOT put `reanalyzed` here
          },
          $set: {
            html_file_id: htmlId,
            screenshot_file_id: shotId,
            page_summary: page_summary_final,
            prompt_ref: promptId,
            reanalyzed: !!already,  // ✅ only here
          }
        },
        { upsert: true }
    );
    page_id = PROVIDED_PAGE_ID;
  } else {
    const up = await Pages.findOneAndUpdate(
        { project_id: PROJECT_ID, url: URL_ID },
        {
          $setOnInsert: {
            created_at: new Date(),
            project_id: PROJECT_ID,
            url: URL_ID,
            // ⚠️ DO NOT put `reanalyzed` here
          },
          $set: {
            html_file_id: htmlId,
            screenshot_file_id: shotId,
            page_summary: page_summary_final,
            prompt_ref: promptId,
            reanalyzed: !!already,  // ✅ only here
          }
        },
        { upsert: true, returnDocument: 'after' }
    );
    page_id = up.value._id;
  }


  // -------- Build Actions --------
  let actionDocs = [];
  const codeTestDocs = [];

  const allowedTypes = new Set(['form','button','link']);
  const domFormContainers = new Set((formGroups || []).map(fg => fg.container_selector).filter(Boolean));

  const sameContainer = (aSel, bSel) => {
    if (!aSel || !bSel) return false;
    const a = aSel.best || aSel.css || '';
    const b = bSel.best || bSel.css || '';
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  };

  const modelElements = Array.isArray(data.interactive_elements)
      ? data.interactive_elements.filter(el => allowedTypes.has(el.element_type))
      : [];

  const filteredModel = modelElements.filter(el => {
    if (el.element_type === 'form') return true;
    const sel = el.selectors || {};
    const s = sel.best || sel.css || '';
    if (!s) return true;
    return ![...domFormContainers].some(c => !!c && (s === c || s.includes(c) || c.includes(s)));
  });

  filteredModel.forEach((el, idx) => {
    if (el.element_type === 'form' && domFormContainers.size) {
      const match = (formGroups || []).find(fg => sameContainer(el.selectors || {}, { css: fg.container_selector }));
      if (match) {
        if (!Array.isArray(el.inputs) || el.inputs.length === 0) el.inputs = match.inputs || [];
        if (!el.submit_button) el.submit_button = match.submit_button || null;
        if (!el.selectors) el.selectors = { best: match.container_selector, css: match.container_selector, xpath: null };
      }
    }

    actionDocs.push({
      project_id: PROJECT_ID,
      page_id: page_id, // ObjectId
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
      ai_confidence: null,
      ordinal: idx,
      created_at: new Date(),
      prompt_ref: promptId,
      source: 'model',
    });

    if (el.playwright_script && typeof el.playwright_script === 'string') {
      codeTestDocs.push({
        target_selector_key: selToKey(el.selectors),
        target_kind: el.element_type,
        project_id: PROJECT_ID,
        created_at: new Date(),
        action_kind: el.element_type,
        playwright_script: el.playwright_script,
        result_checks: Array.isArray(el.result_checks) ? el.result_checks : [],
      });
    }
  });

  // Add grouped form actions (DOM)
  (formGroups || []).forEach((fg, idx) => {
    actionDocs.push({
      project_id: PROJECT_ID,
      page_id: page_id, // ObjectId
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

  // Dedupe identical forms (DOM vs model)
  const deduped = dedupeAndMergeActions(actionDocs);
  actionDocs = deduped.actions;

  // Persist actions & backfill code tests
  if (actionDocs.length) {
    actionDocs.sort((a, b) => {
      const rank = (s) => s === 'dom-grouped' ? 0 : s === 'model' ? 1 : 2;
      const ra = rank(a.source);
      const rb = rank(b.source);
      if (ra !== rb) return ra - rb;
      return (a.ordinal ?? 0) - (b.ordinal ?? 0);
    });
    actionDocs.forEach((a, i) => { a.ordinal = i; });

    const res = await Actions.insertMany(actionDocs);
    if (codeTestDocs.length) {
      const keyToId = new Map(
          actionDocs.map((doc, idx) => [selToKey(doc.selectors) + '::' + doc.kind, res.insertedIds[idx]])
      );
      codeTestDocs.forEach((ct) => {
        const key = String(ct.target_selector_key || '').toLowerCase() + '::' + String(ct.target_kind || '');
        ct.action_id = keyToId.get(key) || null;
        delete ct.target_selector_key; delete ct.target_kind;
      });
      await CodeTests.insertMany(codeTestDocs.filter(ct => ct.action_id));
    }
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
