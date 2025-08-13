#!/usr/bin/env node
// singlePageAnalyzer.js
// One page only: capture HTML + full-page screenshot,
// enumerate interactive elements (forms/links/etc),
// group inputs with their corresponding submit buttons,
// and persist everything to MongoDB (artifacts via GridFS).

import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import OpenAI from 'openai';
import crypto from 'crypto';
import { z } from 'zod';
import { fileURLToPath } from 'url';

// ------------ Env ------------
const {
  TARGET_URL,
  PROJECT_NAME,
  OPENAI_API_KEY,
  MONGODB_URI = 'mongodb://127.0.0.1:27017',
  DB_NAME = 'spa',
  HEADLESS = 'true',
} = process.env;

if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
if (!MONGODB_URI) throw new Error('MONGODB_URI missing');
if (!DB_NAME) throw new Error('DB_NAME missing');
if (!TARGET_URL) throw new Error('TARGET_URL missing');
if (!PROJECT_NAME) throw new Error('PROJECT_NAME missing');

// ------------ Mongo ------------
const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Projects = db.collection('projects');
const Pages = db.collection('pages');
const Actions = db.collection('actions');
const Prompts = db.collection('prompts');
const CodeTests = db.collection('code_tests');
const Results = db.collection('results'); // not used here, but created by runner
const Runs = db.collection('runs');
const bucket = new GridFSBucket(db, { bucketName: 'artifacts' });

// --- OpenAI ------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------ Small utils ------------
function sanitize(name) {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 128);
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function uploadToGridFS({ filename, buffer, contentType, metadata }) {
  return new Promise((resolve, reject) => {
    const upload = bucket.openUploadStream(filename, {
      contentType,
      metadata,
    });
    upload.on('finish', () => resolve(upload.id));
    upload.on('error', reject);
    upload.end(buffer);
  });
}

// ------------ Zod schema for model output ------------
const OptStr = z.string().trim().min(1).max(20_000).nullish();
const NonEmptyStr = z.string().trim().min(1).max(20_000);
const Sel = z.object({
  best: OptStr,
  css: OptStr,
  xpath: OptStr,
}).strict();

const InteractiveElement = z.object({
  element_type: z.enum(['form','button','link','input','select','textarea','other']),
  id: OptStr,
  name: OptStr,
  text: OptStr,
  role: OptStr,
  action: OptStr,
  method: OptStr,
  href: OptStr,
  target: OptStr,
  selectors: Sel.nullish(),
  inputs: z.array(z.object({
    label: OptStr,
    name: OptStr,
    id: OptStr,
    type: OptStr,
    placeholder: OptStr,
    selectors: Sel.nullish(),
    example_value: OptStr,
  }).strict()).default([]),
  submit_button: z.object({
    text: OptStr,
    selectors: Sel.nullish(),
  }).nullish(),
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

// ------------ Prompt builder ------------
function buildExtractionPrompt({ url, html, screenshotDataUrl }) {
  return [
    {
      role: 'system',
      content:
          "You are a meticulous UI analyzer. Output STRICT JSON matching the provided schema. No prose.",
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
              `Analyze ONE web page (no crawling).
Goal: list ALL interactive elements as "page interactive elements".
- Include: <form> forms, pseudo-forms built from <div> + inputs + a button, links, nav buttons, toggles, etc.
- For pseudo-forms: detect a container with fields plus a button that likely submits/executes it (e.g., text contains submit/save/search/send/login/continue).
- Produce robust selectors (best, css, xpath).
- For each element, include a "playwright_script" that performs the user action using Playwright, wrapped in a test function that already has a Playwright Page object.
- Also propose "result_checks" describing how to confirm the action worked.

Return JSON that conforms to the schema. No commentary.`,
        },
        { type: 'text', text: `URL: ${url}` },
        { type: 'text', text: `HTML (truncated):\n${html.slice(0, 150000)}` },
        {
          type: 'image_url',
          image_url: { url: screenshotDataUrl, detail: 'low' },
        },
      ],
    },
  ];
}

// ------------ Safe image embedding ------------
async function toDataUrlPng(buf) {
  const b64 = Buffer.from(buf).toString('base64');
  return `data:image/png;base64,${b64}`;
}

// ------------ JSON coercion helpers ------------
function stripImagesFromMessages(o) {
  try {
    if (Array.isArray(o.messages)) {
      o.messages = o.messages.map(m => {
        if (m.role !== 'user') return m;
        const filtered = (m.content || []).filter(part => part.type !== 'image_url');
        return { ...m, content: filtered };
      });
    }
  } catch {}
  return o;
}

function tryExtractJson(s) {
  const m = String(s).match(/\{[\s\S]*\}$/);
  return m?.[0] ?? null;
}
async function extractLinksAsActionsViaDOM(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      const s = window.getComputedStyle(el);
      return s && s.visibility !== 'hidden' && s.display !== 'none';
    }
    function uniqueCss(el) {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;
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
    function uniqueXPath(el) {
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return `//*[@id="${el.id}"]`;
      const segs = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        const tag = cur.tagName.toLowerCase();
        let i = 1, p = cur.previousElementSibling;
        while (p) { if (p.tagName.toLowerCase() === tag) i++; p = p.previousElementSibling; }
        segs.unshift(`${tag}[${i}]`);
        if (cur.id) { segs.unshift(`*[@id="${cur.id}"]`); return `//*[@id="${cur.id}"]/${segs.slice(1).join('/')}`; }
        cur = cur.parentElement;
      }
      return `/${segs.join('/')}`;
    }

    const anchors = Array.from(document.querySelectorAll('a[href]')).filter(isVisible);
    const cleaned = anchors
        .filter(a => {
          const href = a.getAttribute('href') || '';
          if (!href) return false;
          if (/^javascript:/i.test(href)) return false;
          return true;
        })
        .map(a => {
          const css = uniqueCss(a), xpath = uniqueXPath(a);
          const text = (a.innerText || '').trim() || null;
          return {
            text,
            href: a.href || a.getAttribute('href'),
            selectors: { best: css, css, xpath }
          };
        });

    // de-dupe by href + selector
    const seen = new Set();
    return cleaned.filter(x => {
      const key = `${x.href}::${x.selectors.best}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

// ------------ DOM grouping (inputs ↔ buttons) ------------
async function extractFormGroupsViaDOM(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      const s = window.getComputedStyle(el);
      return s && s.visibility !== 'hidden' && s.display !== 'none';
    }
    function isSubmitty(el) {
      const t = (el.innerText || el.value || '').toLowerCase();
      return (
          el.matches('input[type="submit"], input[type="image"], button[type="submit"]') ||
          /submit|save|search|send|log\s*in|sign\s*in|continue|apply|go|next/i.test(t)
      );
    }
    function uniqueCss(el) {
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let sel = cur.nodeName.toLowerCase();
        if (cur.id) {
          sel = `#${CSS.escape(cur.id)}`;
          parts.unshift(sel);
          break;
        } else {
          const sibs = Array.from(cur.parentElement ? cur.parentElement.children : []);
          const same = sibs.filter(s => s.nodeName === cur.nodeName);
          if (same.length > 1) {
            const idx = same.indexOf(cur) + 1;
            sel += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(sel);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }
    function uniqueXPath(el) {
      if (!el || el.nodeType !== 1) return null;
      if (el.id) return `//*[@id="${el.id}"]`;
      const segs = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        const tag = cur.tagName.toLowerCase();
        let index = 1, p = cur.previousElementSibling;
        while (p) { if (p.tagName.toLowerCase() === tag) index++; p = p.previousElementSibling; }
        segs.unshift(`${tag}[${index}]`);
        if (cur.id) { segs.unshift(`*[@id="${cur.id}"]`); return `//*[@id="${cur.id}"]/${segs.slice(1).join('/')}`; }
        cur = cur.parentElement;
      }
      return `/${segs.join('/')}`;
    }
    function serializeInput(el) {
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
    function serializeButton(el) {
      const css = uniqueCss(el), xpath = uniqueXPath(el);
      const text = (el.innerText || el.value || '').trim() || null;
      return { text, selectors: { best: css, css, xpath } };
    }

    // Lowest common ancestor of a set of nodes
    function lca(nodes) {
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

    const formGroups = [];

    // (1) Real <form>
    for (const f of Array.from(document.querySelectorAll('form'))) {
      const inputs = Array.from(f.querySelectorAll('input, select, textarea')).filter(isVisible);
      const buttons = Array.from(f.querySelectorAll('button, input[type="submit"], input[type="image"], [role="button"]')).filter(isVisible);
      const submit = buttons.find(isSubmitty) || null;
      formGroups.push({
        kind: 'html-form',
        container_selector: uniqueCss(f),
        inputs: inputs.map(serializeInput),
        submit_button: submit ? serializeButton(submit) : null,
        // NOTE: no <a> here either
        button_candidates: buttons.map(serializeButton),
      });
    }

    // (2) Pseudo-forms: inputs + a submit-like control (NO <a> links)
    const candidates = Array.from(document.querySelectorAll('div, section, main, aside, article, form[role="form"]'));
    for (const c of candidates) {
      if (c.closest('form')) continue;
      const visInputs = Array.from(c.querySelectorAll('input, select, textarea')).filter(isVisible);
      if (visInputs.length === 0) continue;

      // Exclude anchors from button candidates so links remain separate actions
      const buttonishSel = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="image"]';
      const visButtons = Array.from(c.querySelectorAll(buttonishSel)).filter(isVisible);
      if (visButtons.length === 0) continue;

      const submit = visButtons.find(isSubmitty) || null;
      if (!submit) continue;

      // Shrink container to the LCA of inputs + submit (avoids #overflow-container)
      const container = lca([...visInputs, submit]) || c;

      formGroups.push({
        kind: 'pseudo-form',
        container_selector: uniqueCss(container),
        inputs: visInputs.map(serializeInput),
        submit_button: serializeButton(submit),
        button_candidates: visButtons.map(serializeButton), // still no <a>
      });
    }

    // ---------- DEDUPE: prefer deepest DOM container ----------
    function selKey(s) { return s?.best || s?.css || null; }
    function inputKeys(g) {
      return (g.inputs || [])
          .map(i => selKey(i.selectors) || i.id || i.name)
          .filter(Boolean)
          .sort();
    }
    function sameSubmit(a, b) {
      return selKey(a.submit_button?.selectors) &&
          selKey(a.submit_button?.selectors) === selKey(b.submit_button?.selectors);
    }
    function jaccard(aArr, bArr) {
      const A = new Set(aArr), B = new Set(bArr);
      const inter = [...A].filter(x => B.has(x)).length;
      const uni = new Set([...A, ...B]).size || 1;
      return inter / uni;
    }
    function containsSelector(outerCss, innerCss) {
      try {
        const inner = document.querySelector(innerCss);
        const outer = document.querySelector(outerCss);
        return !!(inner && outer && outer.contains(inner));
      } catch { return false; }
    }
    function domDepth(cssSel) {
      const el = document.querySelector(cssSel);
      let d = 0, cur = el;
      while (cur && cur !== document.documentElement) { d++; cur = cur.parentElement; }
      return d;
    }

    const withKeys = formGroups.map(g => ({
      ...g,
      _inputsKey: inputKeys(g),
      _submitKey: selKey(g.submit_button?.selectors),
      _container: g.container_selector,
      _depth: domDepth(g.container_selector)
    }));

    const toDrop = new Set();
    for (let i = 0; i < withKeys.length; i++) {
      if (toDrop.has(i)) continue;
      for (let j = i + 1; j < withKeys.length; j++) {
        if (toDrop.has(j)) continue;
        const A = withKeys[i], B = withKeys[j];
        if (!A._submitKey || !B._submitKey) continue;
        if (!sameSubmit(A, B)) continue;

        const sim = jaccard(A._inputsKey, B._inputsKey);
        const overlap =
            (A._container && B._container) &&
            (containsSelector(A._container, B._container) || containsSelector(B._container, A._container));

        if (sim >= 0.8 && overlap) {
          // keep deeper (more specific) container
          const keepI = A._depth >= B._depth ? i : j;
          const dropJ = keepI === i ? j : i;
          toDrop.add(dropJ);
        }
      }
    }

    const deduped = withKeys
        .filter((_, idx) => !toDrop.has(idx))
        .map(({ _inputsKey, _submitKey, _container, _depth, ...g }) => g);

    return deduped;
  });
}

// ------------ Main ------------
(async () => {
  console.log('🧵 Connecting to MongoDB…');
  await client.connect();
  console.log('✅ MongoDB connected');

  const projectRes = await Projects.findOneAndUpdate(
      { name: sanitize(PROJECT_NAME) },
      { $setOnInsert: { name: sanitize(PROJECT_NAME), created_at: new Date() } },
      { upsert: true, returnDocument: 'after' }
  );
  const projectId = projectRes.value?._id ?? projectRes.lastErrorObject?.upserted;
  console.log(`📌 Project ID: ${String(projectId)}`);

  // Launch Playwright (only to load this ONE page)
  console.log('🎭 Launching Playwright browser…');
  const browser = await chromium.launch({ headless: HEADLESS !== 'false' });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`🌐 Navigating to: ${TARGET_URL}`);
  const navRes = await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!navRes) throw new Error('Navigation failed');
  console.log('✅ Navigation complete');

  // Raw HTML → GridFS
  console.log('🧾 Capturing page HTML…');
  const html = await page.content();
  const htmlHash = sha1(Buffer.from(html));
  const htmlId = await uploadToGridFS({
    filename: `page_${htmlHash}.html`,
    buffer: Buffer.from(html, 'utf8'),
    contentType: 'text/html; charset=utf-8',
    metadata: {
      project_id: projectId,
      url: TARGET_URL,
      kind: 'page-html',
    },
  });
  console.log(`📄 HTML stored in GridFS: ${String(htmlId)}`);

  // Full-page screenshot → GridFS
  console.log('📸 Taking full-page screenshot…');
  const shotBuf = await page.screenshot({ fullPage: true, type: 'png' });
  const shotId = await uploadToGridFS({
    filename: `screenshot_${Date.now()}.png`,
    buffer: shotBuf,
    contentType: 'image/png',
    metadata: {
      project_id: projectId,
      url: TARGET_URL,
      kind: 'page-screenshot',
    },
  });
  console.log(`🖼️ Screenshot stored in GridFS: ${String(shotId)}`);

  // DOM-based grouping (inputs ↔ buttons)
  console.log('🧩 Grouping inputs and buttons via DOM…');
  const formGroups = await extractFormGroupsViaDOM(page);
// Extract links as their own actions
  const linkActions = await extractLinksAsActionsViaDOM(page);

  // Prepare prompt for OpenAI (screenshot as data URL, but strip before saving prompt)
  const shotDataUrl = await toDataUrlPng(shotBuf);
  const messages = buildExtractionPrompt({ url: TARGET_URL, html, screenshotDataUrl: shotDataUrl });

  // Save prompt (without the image part) for traceability
  const promptForDb = stripImagesFromMessages(JSON.parse(JSON.stringify({ model: 'gpt-5-mini', messages })));
  const promptId = (await Prompts.insertOne({
    project_id: projectId,
    created_at: new Date(),
    prompt: promptForDb,
    purpose: 'single-page-extract',
  })).insertedId;

  console.log('🧠 Calling model…');
  const chat = await openai.chat.completions.create({
    model: 'gpt-5-mini',
    messages,
    temperature: 1,
    response_format: { type: 'json_object' },
  });

  const raw = chat.choices?.[0]?.message?.content ?? '{}';
  const jsonStr = tryExtractJson(raw) ?? '{}';
  const parsed = ModelResponse.safeParse(JSON.parse(jsonStr));
  if (!parsed.success) {
    console.warn('⚠️ Model output invalid; proceeding with empty interactive elements');
  }
  const data = parsed.success ? parsed.data : { page_summary: null, interactive_elements: [] };

  // Insert Page doc
  const pageDoc = {
    project_id: projectId,
    url: TARGET_URL,
    created_at: new Date(),
    html_file_id: htmlId,
    screenshot_file_id: shotId,
    page_summary: data.page_summary ?? null,
    // NEW: store grouped form info directly on the page
    form_groups: formGroups,
    prompt_ref: promptId,
  };
  const pageId = (await Pages.insertOne(pageDoc)).insertedId;
  console.log(`🧷 Page ID: ${String(pageId)}`);

  // Insert Actions + CodeTests from model output (unchanged semantics),
  // but make sure "inputs + submit_button" are preserved (grouped) on each action.
  const actionDocs = [];
  const codeTestDocs = [];

  data.interactive_elements.forEach((el, idx) => {
    const aDoc = {
      project_id: projectId,
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
      // ✅ ensure grouped information travels with the action
      inputs: Array.isArray(el.inputs) ? el.inputs : [],
      submit_button: el.submit_button ?? null,
      ai_confidence: el.ai_confidence ?? null,
      ordinal: idx,
      created_at: new Date(),
      prompt_ref: promptId,
      source: 'model',
    };
    actionDocs.push(aDoc);

    if (el.playwright_script) {
      codeTestDocs.push({
        project_id: projectId,
        page_id: pageId,
        action_id: null, // backfilled after insertMany
        model: 'gpt-5-mini',
        script: el.playwright_script,
        result_checks: el.result_checks ?? [],
        created_at: new Date(),
        prompt_ref: promptId,
      });
    }
  });
// Add links as separate actions
  linkActions.forEach((lnk, i) => {
    actionDocs.push({
      project_id: projectId,
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
      ordinal: 20_000 + i,   // any placeholder; you can re-sequence later
      created_at: new Date(),
      prompt_ref: promptId,
      source: 'dom-link',
    });
  });

  // (Optional) Also create actions derived from DOM grouping, so every grouped form
  // is actionable even if the model missed it. These won't have scripts by default.
  formGroups.forEach((fg, idx) => {
    actionDocs.push({
      project_id: projectId,
      page_id: pageId,
      kind: fg.kind === 'html-form' ? 'form' : 'form',
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
      ordinal: 10_000 + idx, // after model actions
      created_at: new Date(),
      prompt_ref: promptId,
      source: 'dom-grouped',
    });
  });

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

  // Backfill code tests -> action ids (model-derived actions, in order)
  if (codeTestDocs.length && actionDocs.length) {
    // insertedActionIds is keyed by the sorted index of actionDocs
    const modelIdsInOrder = actionDocs
        .map((doc, idx) => ({ idx, doc }))
        .filter(x => x.doc.source === 'model')
        .map(x => insertedActionIds[x.idx]); // preserve order

    codeTestDocs.forEach((ct, i) => {
      ct.action_id = modelIdsInOrder[i]; // aligns with codeTestDocs order
    });

    // Only insert if we successfully mapped an action_id
    await CodeTests.insertMany(codeTestDocs.filter(ct => ct.action_id));
  }


  console.log('✅ Done. Page, artifacts (GridFS), grouped forms, actions, and code tests saved.');
  await context.close();
  await browser.close();
  await client.close();
})().catch(async (e) => {
  console.error(e);
  try { await client.close(); } catch {}
  process.exit(1);
});
