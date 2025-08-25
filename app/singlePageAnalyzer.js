import { analyzePage } from './pageAnalysis.js';
import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
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

// ---------------- Env ----------------
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
const bucket = new GridFSBucket(db, { bucketName: 'artifacts' });

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
function identityUrl(u) { const x = new URL(u); x.hash = ''; return x.toString(); }
function deriveShortSummary(html) {
  try {
    const title = (html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1] || '').replace(/\\s+/g,' ').trim();
    const h1 = (html.match(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i)?.[1] || '').replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim();
    const base = [title, h1].filter(Boolean).join(' — ');
    if (!base) return 'Web page summary unavailable.';
    const words = base.split(/\\s+/);
    return words.slice(0, 40).join(' ');
  } catch { return 'Web page summary unavailable.'; }
}
async function toDataUrlPng(buf) { return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`; }

// ---- Zod schema for model output ----
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

// ---- Merge helpers ----
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
      if ((!bi.example_value || !String(bi.example_value).trim()) && (ai.example_value && String(ai.example_value).trim())) bi.example_value = ai.example_value;
      if (!bi.selectors && ai.selectors) bi.selectors = ai.selectors;
      for (const f of ['label','type','placeholder','name','id']) { if (!bi[f] && ai[f]) bi[f] = ai[f]; }
    } else {
      out.push(ai); idx.set(k, out.length - 1);
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
function dedupeAndMergeActions(actionDocs) {
  const formsByKey = new Map();
  const removeIdx = new Set();
  for (let i = 0; i < actionDocs.length; i++) {
    const doc = actionDocs[i];
    if (doc.kind !== 'form') continue;
    const key = selToKey(doc.selectors);
    if (!key) continue;
    if (!formsByKey.has(key)) { formsByKey.set(key, i); continue; }
    const keepIdx = formsByKey.get(key);
    const w = actionDocs[keepIdx];
    const l = actionDocs[i];
    if (!w.selectors && l.selectors) w.selectors = l.selectors;
    w.inputs = mergeInputs(Array.isArray(w.inputs) ? w.inputs : [], Array.isArray(l.inputs) ? l.inputs : []);
    w.submit_button = mergeSubmitButton(w.submit_button, l.submit_button);
    removeIdx.add(i);
  }
  const out = actionDocs.filter((_, idx) => !removeIdx.has(idx));
  return { actions: out, removedIndices: [...removeIdx] };
}

// ---------------- Main ----------------
(async () => {
  console.log('🧵 Connecting to MongoDB…');
  await client.connect();
  console.log('✅ MongoDB connected');

  await Projects.updateOne(
    { _id: PROJECT_ID },
    { $setOnInsert: { _id: PROJECT_ID, name: `project_${PROJECT_ID.toHexString()}`, created_at: new Date() } },
    { upsert: true }
  );
  console.log(`📌 Using project _id: ${PROJECT_ID}`);

  const URL_ID = identityUrl(TARGET_URL);
  const existing = await Pages.findOne({ project_id: PROJECT_ID, url: URL_ID });
  const alreadyAnalyzed = !!(existing && (existing.last_analyzed_at || existing.prompt_ref || existing.page_summary));
  if (!PROVIDED_PAGE_ID && alreadyAnalyzed && !FORCE) {
    console.log('ℹ️ Page already analyzed for this project. Use --force to re-analyze.');
    await client.close();
    process.exit(0);
  }

  // Launch browser and capture HTML + screenshot
  const browser = await chromium.launch({ headless: String(HEADLESS) !== 'false' });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 60_000 }).catch(()=>{});
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  const html = await page.content();
  const screenshotBuf = await page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
  const screenshotDataUrl = screenshotBuf ? await toDataUrlPng(screenshotBuf) : null;

  // Ask model for analysis (json object mode)
  const raw = await analyzePage({
    url: TARGET_URL,
    html,
    screenshotDataUrl,
    response_format: { type: 'json_object' },
  });
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (!data) {
    console.error('❌ Model did not return valid JSON; aborting.');
    await browser.close(); await client.close(); process.exit(1);
  }
  let parsed;
  try { parsed = ModelResponse.parse(data); } catch (e) {
    console.warn('⚠️ Model response failed schema validation; attempting best-effort use.');
    parsed = { page_summary: deriveShortSummary(html), interactive_elements: Array.isArray(data?.interactive_elements) ? data.interactive_elements : [] };
  }

  // Upsert page & upload artifacts
  const htmlId = await uploadToGridFS({
    filename: `page_${sha1(Buffer.from(URL_ID + html)).slice(0,8)}.html`,
    buffer: Buffer.from(html, 'utf8'),
    contentType: 'text/html; charset=utf-8',
    metadata: { project_id: PROJECT_ID, url: URL_ID, kind: 'page-html' },
  });
  let shotId = null;
  if (screenshotBuf) {
    shotId = await uploadToGridFS({
      filename: `page_${Date.now()}.png`,
      buffer: screenshotBuf,
      contentType: 'image/png',
      metadata: { project_id: PROJECT_ID, url: URL_ID, kind: 'page-screenshot' },
    });
  }

  let page_id = PROVIDED_PAGE_ID || existing?._id || null;
  if (!page_id) {
    const ins = await Pages.insertOne({
      project_id: PROJECT_ID, url: URL_ID,
      created_at: new Date(), page_summary: parsed.page_summary, html_file_id: htmlId, screenshot_file_id: shotId,
      prompt_ref: null, reanalyzed: false, last_analyzed_at: null
    });
    page_id = ins.insertedId;
  } else {
    await Pages.updateOne({ _id: page_id }, {
      $set: { page_summary: parsed.page_summary, html_file_id: htmlId, screenshot_file_id: shotId }
    });
  }

  // Build actions from interactive_elements
  const actionDocs = [];
  for (const el of parsed.interactive_elements || []) {
    if (el.element_type === 'form') {
      actionDocs.push({
        project_id: PROJECT_ID, page_id, kind: 'form', source: 'model',
        selectors: el.selectors || null, inputs: Array.isArray(el.inputs) ? el.inputs : [],
        submit_button: el.submit_button || null, method: el.method || null, action: el.action || null,
        result_checks: Array.isArray(el.result_checks) ? el.result_checks : [],
        ai_confidence: typeof el.ai_confidence === 'number' ? el.ai_confidence : 0.5,
        created_at: new Date(),
      });
    }
  }
  const { actions: deduped } = dedupeAndMergeActions(actionDocs);
  if (deduped.length) await Actions.insertMany(deduped);

  await Pages.updateOne({ _id: page_id }, { $set: { last_analyzed_at: new Date(), last_analyzed_run_id: null, reanalyzed: !!alreadyAnalyzed } });

  console.log('✅ Analysis complete.');
  await context.close();
  await browser.close();
  await client.close();
})().catch(async (e) => {
  console.error(e);
  try { await client.close(); } catch {}
  process.exit(1);
});