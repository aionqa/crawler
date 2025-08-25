import { buildLoginMessages, generateLoginStatements } from '../ai/login.js';
import { openai } from '../ai/client.js'; // needed if you still call openai.chat below
import { codeWrap, safeEvalFunction } from '../runtime/sandbox.js';

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { spawn } from 'child_process';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
// ---------------- CLI ----------------
function argvToOpts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run_id') o.run_id = argv[++i];
    else if (a === '--project_id') o.project_id = argv[++i];
    else if (a === '--seed_url') o.seed_url = argv[++i];
    else if (a === '--login_url') o.login_url = argv[++i];
    else if (a === '--username') o.username = argv[++i];
    else if (a === '--password') o.password = argv[++i];
    else if (a === '--analyzer_bin') o.analyzer_bin = argv[++i];
    else if (a === '--executor_bin') o.executor_bin = argv[++i];
    else if (a === '--headless') o.headless = argv[++i];
    else if (a === '--concurrency') o.concurrency = argv[++i];
    else if (a === '--max_pages') o.max_pages = argv[++i];
    else if (a === '--max_depth') o.max_depth = argv[++i];
    else if (a === '--dedupe') o.dedupe = argv[++i];
  }
  return o;
}
const opts = argvToOpts(process.argv.slice(2));

function mustObjectId(id, flagName) {
  if (!id || !ObjectId.isValid(id)) {
    console.error(`${flagName} must be a valid ObjectId`);
    process.exit(2);
  }
  return new ObjectId(id);
}

function normalizeUrl(u) {
  try { const url = new URL(u); url.hash = ''; return url.toString(); } catch { return ''; }
}
function sameHost(u, base) {
  try { const A = new URL(u); const B = new URL(base); return A.host === B.host; } catch { return false; }
}
function buildPromptForLogin({ loginUrl }) {
  return buildLoginMessages({ loginUrl });
}
// ---------------- Env & Mongo ----------------
const {
  MONGODB_URI = 'mongodb://127.0.0.1:27017',
  DB_NAME = 'spa',
  OPENAI_API_KEY,
} = process.env;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Projects = db.collection('projects');
const Pages = db.collection('pages');
const Actions = db.collection('actions');
const Runs = db.collection('runs');
const Frontier = db.collection('run_frontier');
// ---------------- Child process helpers ----------------
function runNodeScript(binPath, args, { env = process.env, debug = true, label } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [binPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
    const name = (label || binPath.split(/[\\/]/).pop());
    const tag = `[child:${name}#${proc.pid}]`;
    let out = '', err = '';
    if (debug) {
      const prettyArgs = args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
      console.log(`${tag} spawn: node ${binPath} ${prettyArgs}`);
    }
    proc.stdout.on('data', (d) => { const s = d.toString(); out += s; if (debug) process.stdout.write(`${tag} ${s}`); });
    proc.stderr.on('data', (d) => { const s = d.toString(); err += s; if (debug) process.stderr.write(`${tag} ${s}`); });
    proc.on('close', (code) => { if (debug) console.log(`${tag} exit ${code}`); resolve({ code, out, err }); });
  });
}

// Frontier helpers
async function addToFrontier({ run_id, url, depth, discovered_from }) {
  const u = normalizeUrl(url);
  const now = new Date();
  try {
    const res = await Frontier.updateOne(
      { run_id, url: u },
      {
        $setOnInsert: {
          run_id, url: u, depth, discovered_from: discovered_from ? normalizeUrl(discovered_from) : null,
          status: 'pending', created_at: now, picked_at: null
        },
        $set: { updated_at: now }
      },
      { upsert: true }
    );
    if (res.upsertedId) return res.upsertedId._id;
    const existing = await Frontier.findOne({ run_id, url: u });
    return existing?._id || null;
  } catch (e) {
    if (e && e.code === 11000) {
      const existing = await Frontier.findOne({ run_id, url: u });
      return existing?._id || null;
    }
    throw e;
  }
}
async function claimNextFrontier(runId) {
  const now = new Date();
  const leaseExpired = new Date(now.getTime() - Number(process.env.FRONTIER_LEASE_MS || 300000));
  const result = await Frontier.findOneAndUpdate(
    { run_id: runId, $or: [{ status: 'pending' }, { status: 'processing', picked_at: { $lt: leaseExpired } }] },
    { $set: { status: 'processing', picked_at: now, updated_at: now } },
    { sort: { status: 1, depth: 1, _id: 1 }, returnDocument: 'after', includeResultMetadata: true }
  );
  return (result && 'value' in result ? result.value : result) ?? null;
}
async function markFrontier(runFrontierId, patch) {
  await Frontier.updateOne({ _id: runFrontierId }, { $set: { ...patch, updated_at: new Date() } });
}

function extractLinks(html, baseUrl) {
  const out = [];
  try {
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href) return;
      try { href = new URL(href, baseUrl).toString(); } catch { return; }
      if (!(href.startsWith('http://') || href.startsWith('https://'))) return;
      out.push(normalizeUrl(href));
    });
  } catch {}
  return Array.from(new Set(out));
}
async function fetchHtml(url) {
  try {
    const f = globalThis.fetch || (await import('node-fetch')).default;
    const res = await f(url, { redirect: 'follow' });
    if (!res.ok) return '';
    return await res.text();
  } catch { return ''; }
}

async function ensureFrontierSeeded(run) {
  const [pending, processing, total] = await Promise.all([
    Frontier.countDocuments({ run_id: run._id, status: 'pending' }),
    Frontier.countDocuments({ run_id: run._id, status: 'processing' }),
    Frontier.countDocuments({ run_id: run._id }),
  ]);
  if (total === 0 || (pending === 0 && processing === 0)) {
    await addToFrontier({ run_id: run._id, url: run.seed_url, depth: 0 });
    console.log('🌱 Seeded frontier with seed_url');
  }
}

function escapeForRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function findOrCreateProjectByUrl(seed_url, providedProjectId, creds, login_url) {
  if (providedProjectId) {
    const _id = mustObjectId(providedProjectId, '--project_id');
    const proj = await Projects.findOne({ _id });
    if (!proj) throw new Error('Project not found for provided --project_id');
    if (creds?.username && creds?.password) {
      await Projects.updateOne(
        { _id },
        { $set: { credentials: { type: 'login-form', username: creds.username, password: creds.password, login_url: login_url || seed_url } } }
      );
    }
    return await Projects.findOne({ _id });
  }

  const url = normalizeUrl(seed_url);
  if (!url) throw new Error('--seed_url must be a valid URL when --project_id is not provided');
  const host = new URL(url).host;

  const exact = await Pages.findOne({ url });
  if (exact) {
    if (creds?.username && creds?.password) {
      await Projects.updateOne(
        { _id: exact.project_id },
        { $set: { credentials: { type: 'login-form', username: creds.username, password: creds.password, login_url: login_url || seed_url } } }
      );
    }
    return await Projects.findOne({ _id: exact.project_id });
  }

  const escapedHost = escapeForRegex(host);
  const hostPattern = new RegExp(`^https?://${escapedHost}(?:[/:?#]|$)`, 'i');
  const cursor = Pages.find({ url: { $regex: hostPattern } });
  const projIds = new Set();
  for await (const p of cursor) projIds.add(String(p.project_id));
  if (projIds.size === 1) {
    const _id = new ObjectId([...projIds][0]);
    if (creds?.username && creds?.password) {
      await Projects.updateOne(
        { _id },
        { $set: { credentials: { type: 'login-form', username: creds.username, password: creds.password, login_url: login_url || seed_url } } }
      );
    }
    return await Projects.findOne({ _id });
  }

  const name = host;
  const baseDoc = { name, created_at: new Date(), cookies: [], credentials: null, storage_state: null, auth: null };
  if (creds?.username && creds?.password) baseDoc.credentials = { type: 'login-form', username: creds.username, password: creds.password, login_url: login_url || seed_url };
  const ins = await Projects.insertOne(baseDoc);
  return await Projects.findOne({ _id: ins.insertedId });
}

// DB bootstrap
async function ensureDatabaseSetup(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  async function ensureCollection(name) {
    if (!existing.has(name)) {
      await db.createCollection(name);
      console.log(`🆕 Created collection: ${name}`);
    }
    return db.collection(name);
  }
  await ensureCollection('projects');
  await ensureCollection('pages');
  await ensureCollection('actions');
  await ensureCollection('runs');
  await ensureCollection('run_frontier');

  await Projects.createIndex({ name: 1 }, { name: 'projects_name_idx' });
  await Pages.createIndex({ project_id: 1, url: 1 }, { unique: true, name: 'pages_project_url_uq' });
  await Pages.createIndex({ project_id: 1 }, { name: 'pages_project_idx' });
  await Actions.createIndex({ project_id: 1, page_id: 1 }, { name: 'actions_project_page_idx' });
  await Runs.createIndex({ project_id: 1 }, { name: 'runs_project_idx' });
  await Runs.createIndex({ status: 1, created_at: -1 }, { name: 'runs_status_created_idx' });
  await Frontier.createIndex({ run_id: 1, url: 1 }, { unique: true, name: 'frontier_run_url_uq' });
  await Frontier.createIndex({ run_id: 1, status: 1, picked_at: 1, depth: 1 }, { name: 'frontier_claim_idx' });
}

async function performLoginIfNeeded(run, { force = false } = {}) {
  const project = await Projects.findOne({ _id: run.project_id });
  const creds = project?.credentials;
  if (!creds?.username || !creds?.password) return { skipped: true };

  const loginUrl = normalizeUrl(opts.login_url || creds.login_url || run.seed_url);
  if (!loginUrl) return { skipped: true };

  console.log(`🔐 AI-driven login at: ${loginUrl}`);

  const browser = await chromium.launch({ headless: String(run.options.headless) !== 'false' });
  const context = await browser.newContext();
  const page = await context.newPage();

  const helpers = {
    async waitStable() { try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {} },
  };

  await page.goto(loginUrl, { waitUntil: 'load', timeout: 60_000 }).catch(()=>{});

  const loginMsgs = buildPromptForLogin({ loginUrl });
  const loginChat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: loginMsgs });
  const loginStatements = (loginChat.choices?.[0]?.message?.content || '').trim();

  const wrappedLogin = codeWrap(loginStatements);
  try {
    const fnLogin = await safeEvalFunction(wrappedLogin, { console, page, project, helpers });
    await fnLogin({ page, project, helpers });
    await helpers.waitStable();
  } catch (e) {
    console.error('❌ AI login code execution error:', e?.message || e);
  }

  // Give the app a moment to write tokens
  await page.waitForTimeout(1500).catch(()=>{});

  const storageState = await context.storageState().catch(() => null);
  try {
    await Projects.updateOne(
      { _id: run.project_id },
      {
        $set: {
          storage_state: storageState,
          cookies: storageState?.cookies || [],
          'credentials.login_url': loginUrl,
          auth: {
            last_login_at: new Date(),
            acknowledged_success: !!(storageState && (storageState.cookies?.length || storageState.origins?.length)),
            login_url: loginUrl,
          }
        }
      }
    );
    console.log('✅ Login state saved to project.');
  } catch (e) {
    console.warn('⚠️ Could not store login state:', e?.message || e);
  }

  await context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  return { done: true };
}

async function ensureRun(opts) {
  if (opts.run_id) {
    const _id = mustObjectId(opts.run_id, '--run_id');
    const doc = await Runs.findOne({ _id });
    if (!doc) throw new Error('Run not found');
    if (opts.username && opts.password) {
      await Projects.updateOne(
        { _id: doc.project_id },
        { $set: { credentials: { type: 'login-form', username: opts.username, password: opts.password, login_url: opts.login_url || doc.seed_url } } }
      );
    }
    return doc;
  }

  const seed_url = normalizeUrl(opts.seed_url);
  if (!seed_url) throw new Error('--seed_url is required for a new run');
  const project = await findOrCreateProjectByUrl(seed_url, opts.project_id, { username: opts.username, password: opts.password }, opts.login_url);
  const host = new URL(seed_url).host;
  const runDoc = {
    project_id: project._id,
    seed_url,
    allowed_host: host,
    status: 'running',
    created_at: new Date(),
    updated_at: new Date(),
    stop_requested: false,
    options: {
      headless: String(opts.headless ?? 'true'),
      analyzer_bin: opts.analyzer_bin || './singlePageAnalyzer.js',
      executor_bin: opts.executor_bin || './actionAiExecutor.js',
      max_pages: Number(opts.max_pages || '200'),
      max_depth: Number(opts.max_depth || '6'),
      concurrency: Number(opts.concurrency || '1'),
      dedupe: (opts.dedupe || 'run'),
    },
    stats: { pages_claimed: 0, pages_done: 0, actions_run: 0, errors: 0, last_url: null },
    notes: [],
  };
  const ins = await Runs.insertOne(runDoc);
  const run_id = ins.insertedId;
  await addToFrontier({ run_id, url: seed_url, depth: 0 });
  return await Runs.findOne({ _id: run_id });
}

async function updateRun(_id, patch) {
  await Runs.updateOne({ _id }, { $set: { ...patch, updated_at: new Date() } });
}

async function tickStopFlag(run) {
  const fresh = await Runs.findOne({ _id: run._id });
  return !!fresh?.stop_requested;
}

async function upsertPage({ project_id, url }) {
  const u = normalizeUrl(url);
  const now = new Date();
  const res = await Pages.findOneAndUpdate(
    { project_id, url: u },
    {
      $setOnInsert: {
        project_id, url: u, created_at: now, page_summary: null, html_file_id: null,
        screenshot_file_id: null, prompt_ref: null, reanalyzed: false, last_analyzed_at: null
      }
    },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = res.value || await Pages.findOne({ project_id, url: u });
  return doc._id;
}

async function shouldSkipAnalyze(run, pageUrl) {
  const u = normalizeUrl(pageUrl);
  if (run?.options?.dedupe === 'project') {
    const p = await Pages.findOne({ project_id: run.project_id, url: u, last_analyzed_at: { $ne: null } });
    return !!p;
  }
  if (run?.options?.dedupe === 'run') {
    const wasDone = await Frontier.findOne({ run_id: run._id, url: u, status: 'done' });
    if (wasDone) return true;
    const p = await Pages.findOne({ project_id: run.project_id, url: u, last_analyzed_run_id: run._id });
    return !!p;
  }
  return false;
}

async function analyzeAndExecuteForPage({ run, pageUrl, workerId }) {
  const { project_id } = run;
  const analyzer = run.options.analyzer_bin;
  const executor = run.options.executor_bin;

  // 1) Ensure page doc exists
  const page_id = await upsertPage({ project_id: run.project_id, url: pageUrl });

  // 1a) Optional skip
  const skipAnalyze = await shouldSkipAnalyze(run, pageUrl);
  if (!skipAnalyze) {
    // 2) Analyze page to discover actions
    const forceArg = (run.options.dedupe !== 'project') ? ['--force'] : [];
    const aArgs = ['--url', pageUrl, '--project', String(project_id), '--page_id', String(page_id), ...forceArg];
    const aRes = await runNodeScript(analyzer, aArgs, { label: `analyzer ${new URL(pageUrl).pathname}` });
    await Runs.updateOne(
      { _id: run._id },
      { $push: { notes: { stage: 'analyze', url: pageUrl, exit_code: aRes.code, out: aRes.out.slice(0, 4000), err: aRes.err.slice(0, 4000), ts: new Date() } }, $set: { 'stats.last_url': pageUrl } }
    );
    if (aRes.code !== 0) throw new Error(`Analyzer failed for ${pageUrl} (exit ${aRes.code})`);
    await Pages.updateOne({ _id: page_id }, { $set: { last_analyzed_at: new Date(), last_analyzed_run_id: run._id, reanalyzed: true } });

    // 3) Execute actions for that page
    const actions = await Actions.find({
      $or: [
        { project_id: run.project_id, page_id },
        { project_id: String(run.project_id), page_id: String(page_id) }
      ]
    }).toArray();

    for (const action of actions) {
      const eArgs = ['--project_id', String(project_id), '--page_id', String(page_id), '--action_id', String(action._id), '--headless', String(run.options.headless)];
      const eRes = await runNodeScript(executor, eArgs, { label: `executor ${action._id}` });
      await Runs.updateOne(
        { _id: run._id },
        { $inc: { 'stats.actions_run': 1 }, $push: { notes: { stage: 'execute', url: pageUrl, action_id: action._id, exit_code: eRes.code, out: eRes.out.slice(0, 4000), err: eRes.err.slice(0, 4000), ts: new Date() } } }
      );
    }
  }

  // 4) Crawl links on the page (same host)
  const html = await fetchHtml(pageUrl);
  const links = extractLinks(html, pageUrl).filter(u => sameHost(u, run.seed_url));
  return { page_id, links };
}

async function main() {
  await client.connect();
  console.log('✅ MongoDB connected');
  await ensureDatabaseSetup(db);
  let run = await ensureRun(opts);

  const patch = { options: { ...run.options } };
  if (opts.analyzer_bin) patch.options.analyzer_bin = opts.analyzer_bin;
  if (opts.executor_bin) patch.options.executor_bin = opts.executor_bin;
  if (typeof opts.headless !== 'undefined') patch.options.headless = String(opts.headless);
  if (typeof opts.max_pages !== 'undefined') patch.options.max_pages = Number(opts.max_pages);
  if (typeof opts.max_depth !== 'undefined') patch.options.max_depth = Number(opts.max_depth);
  if (typeof opts.concurrency !== 'undefined') patch.options.concurrency = Number(opts.concurrency);
  if (typeof opts.dedupe !== 'undefined') patch.options.dedupe = String(opts.dedupe);

  await updateRun(run._id, patch);
  run = await Runs.findOne({ _id: run._id });

  console.log(`▶️  Run ID: ${run._id}`);

  // 🔐 LOGIN FIRST (if credentials present)
  const loginRes = await performLoginIfNeeded(run);
  if (loginRes?.done) console.log('🔓 Auth ready; starting analysis…');
  else console.log('ℹ️ No login performed (missing creds or URL).');

  await ensureFrontierSeeded(run);

  let stopping = false;
  process.on('SIGINT', async () => {
    console.log(`\n✋ Caught SIGINT; marking run paused…`);
    stopping = true;
    await updateRun(run._id, { status: 'paused' });
    process.exit(130);
  });

  await updateRun(run._id, { status: 'running' });
  await Frontier.updateMany({ run_id: run._id, status: 'processing' }, { $set: { status: 'pending' } });

  const workerCount = Math.max(1, Number(run.options.concurrency || 1));
  console.log(`🧵 Starting ${workerCount} worker(s)…`);

  async function workerLoop(workerId) {
    const statsEveryN = 10;
    let iter = 0;
    while (!stopping) {
      const freshStop = await tickStopFlag(run);
      if (freshStop) { console.log(`[worker:${workerId}] 🛑 stop_requested=true — pausing`); stopping = true; break; }

      const doneCount = await Frontier.countDocuments({ run_id: run._id, status: 'done' });
      if (doneCount >= run.options.max_pages) { console.log(`[worker:${workerId}] ⛳ Reached max_pages=${run.options.max_pages}`); stopping = true; break; }

      if ((iter++ % statsEveryN) === 0 && workerId === 1) {
        const [p, pr, d] = await Promise.all([
          Frontier.countDocuments({ run_id: run._id, status: 'pending' }),
          Frontier.countDocuments({ run_id: run._id, status: 'processing' }),
          Frontier.countDocuments({ run_id: run._id, status: 'done' }),
        ]);
        console.log(`Frontier — pending:${p} processing:${pr} done:${d}`);
      }

      const f = await claimNextFrontier(run._id);
      if (!f) { await new Promise(r => setTimeout(r, 500)); continue; }

      try {
        await markFrontier(f._id, { status: 'processing' });
        const { links } = await analyzeAndExecuteForPage({ run, pageUrl: f.url, workerId });
        const depth = (f.depth || 0) + 1;
        if (depth <= run.options.max_depth) {
          for (const link of links) await addToFrontier({ run_id: run._id, url: link, depth, discovered_from: f.url });
        }
        await markFrontier(f._id, { status: 'done' });
      } catch (e) {
        await markFrontier(f._id, { status: 'pending' });
        await Runs.updateOne({ _id: run._id }, { $inc: { 'stats.errors': 1 }, $push: { notes: { stage: 'error', url: f.url, err: String(e?.stack || e), ts: new Date() } } });
      }
    }
  }

  const workers = [];
  for (let i = 1; i <= workerCount; i++) workers.push(workerLoop(i));
  await Promise.all(workers);

  await updateRun(run._id, { status: 'finished' });
  console.log('✅ Run finished.');
  await client.close();
}

main().catch(async (e) => {
  console.error(e);
  try { await client.close(); } catch {}
  process.exit(1);
});
